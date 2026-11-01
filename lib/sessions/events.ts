/**
 * Сохранение событий потока eve в `session_events`.
 *
 * Событие, которое получает хук, не несёт своего номера в потоке, а
 * `startIndex` при возобновлении — абсолютный номер события. Поэтому хук
 * просит синхронизацию: читаем поток с сохранённой позиции, вставляем
 * события и двигаем `stream_cursor` одной транзакцией. Условие «курсор всё
 * ещё равен прочитанной позиции» и игнорирование конфликтов делают вставку
 * идемпотентной даже при синхронизациях из разных процессов.
 */
import type { MessageStreamEvent } from "eve/client";
import { sessions } from "eve/server";
import { and, eq, sql } from "drizzle-orm";

import { getDb } from "../db/client";
import { appSessions, sessionEvents } from "../db/schema";
import { sleep } from "../sleep";
import { findAppSessionById, hasSessionEvent, setTitleIfEmpty } from "./service";

/** Чтение потока сессии с абсолютного номера события. */
export type SessionEventReader = (
  eveSessionId: string,
  startIndex: number,
) => AsyncIterable<MessageStreamEvent>;

const defaultReader: SessionEventReader = (eveSessionId, startIndex) =>
  sessions.attach(eveSessionId).stream({ startIndex, follow: false });

/** События-приращения: синхронизация идёт без ожидания, чтобы не тормозить поток. */
export const INCREMENTAL_EVENTS: ReadonlySet<string> = new Set([
  "message.appended",
  "reasoning.appended",
  "action.input.appended",
]);

/** События-границы: хук ждёт, пока событие окажется в базе. */
export const BOUNDARY_EVENTS: ReadonlySet<string> = new Set([
  "session.started",
  "turn.completed",
  "turn.failed",
  "turn.cancelled",
  "session.waiting",
  "session.failed",
  "session.completed",
  "input.requested",
]);

/** События, после которых меняется `updated_at` сессии. */
const TOUCH_EVENTS: ReadonlySet<string> = new Set(["message.received", "session.waiting"]);

const MAX_SYNC_ATTEMPTS = 5;
const CONFIRM_ATTEMPTS = 5;
const CONFIRM_DELAY_MS = 200;

export interface SyncResult {
  /** Сколько событий удалось сохранить за этот проход. */
  readonly stored: number;
  /** Позиция курсора после прохода. */
  readonly cursor: number;
}

/**
 * Убирает символ NUL из любых строк полезной нагрузки рекурсивно: `jsonb`
 * Postgres отвергает его, и без очистки курсор навсегда остановился бы.
 */
export function stripNullCharacters<T>(value: T): T {
  if (typeof value === "string") return value.replaceAll("\u0000", "") as T;
  if (Array.isArray(value)) return value.map((item) => stripNullCharacters(item)) as T;
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      result[key] = stripNullCharacters(item);
    }
    return result as T;
  }
  return value;
}

function eventId(event: MessageStreamEvent): string | null {
  return event.meta?.id ?? null;
}

/**
 * Один проход синхронизации. `null` — сессия исчезла или ещё не привязана
 * к сессии eve. При гонке с другой синхронизацией перечитывает поток.
 */
export async function syncAppSession(
  appSessionId: string,
  reader: SessionEventReader = defaultReader,
): Promise<SyncResult> {
  for (let attempt = 0; attempt < MAX_SYNC_ATTEMPTS; attempt += 1) {
    const session = await findAppSessionById(appSessionId);
    if (session === null || session.eveSessionId === null) {
      return { stored: 0, cursor: session?.streamCursor ?? 0 };
    }

    const cursor = session.streamCursor;
    const events: MessageStreamEvent[] = [];
    for await (const event of reader(session.eveSessionId, cursor)) {
      events.push(event);
    }
    if (events.length === 0) return { stored: 0, cursor };

    const nextCursor = cursor + events.length;
    const rows = events.map((event, index) => ({
      appSessionId,
      seq: cursor + index,
      eventId: eventId(event),
      payload: stripNullCharacters(event),
    }));
    const touch = events.some((event) => TOUCH_EVENTS.has(event.type));

    const stored = await getDb().transaction(async (tx) => {
      const updated = await tx
        .update(appSessions)
        .set({ streamCursor: nextCursor, ...(touch ? { updatedAt: sql`now()` } : {}) })
        .where(and(eq(appSessions.id, appSessionId), eq(appSessions.streamCursor, cursor)))
        .returning({ id: appSessions.id });
      if (updated.length === 0) return false;

      await tx
        .insert(sessionEvents)
        .values(rows)
        .onConflictDoNothing({ target: [sessionEvents.appSessionId, sessionEvents.seq] });
      await setTitleIfEmpty(tx, appSessionId, events);
      return true;
    });

    if (stored) return { stored: events.length, cursor: nextCursor };
  }

  const session = await findAppSessionById(appSessionId);
  return { stored: 0, cursor: session?.streamCursor ?? 0 };
}

const inFlight = new Map<string, Promise<SyncResult>>();
const rerunRequested = new Set<string>();

async function runUntilQuiet(
  appSessionId: string,
  reader: SessionEventReader,
): Promise<SyncResult> {
  let result: SyncResult = { stored: 0, cursor: 0 };
  do {
    rerunRequested.delete(appSessionId);
    result = await syncAppSession(appSessionId, reader);
  } while (rerunRequested.has(appSessionId));
  return result;
}

/**
 * Запрашивает синхронизацию сессии. Одновременно в процессе идёт не больше
 * одной на сессию; пришедшее за время чтения подбирает повторное чтение.
 */
export function requestSessionSync(
  appSessionId: string,
  reader: SessionEventReader = defaultReader,
): Promise<SyncResult> {
  const current = inFlight.get(appSessionId);
  if (current !== undefined) {
    rerunRequested.add(appSessionId);
    return current;
  }

  const promise = runUntilQuiet(appSessionId, reader).finally(() => {
    inFlight.delete(appSessionId);
    // Запрос пришёл между проверкой и удалением — не теряем его.
    if (rerunRequested.has(appSessionId)) void requestSessionSync(appSessionId, reader);
  });
  inFlight.set(appSessionId, promise);
  return promise;
}

/**
 * Синхронизирует и дожидается, что событие с этим `meta.id` сохранено.
 * Чтение внутри хука может не видеть событие, вызвавшее хук, пока идёт сброс
 * записи, поэтому повторяет до 5 раз с паузой 200 мс.
 */
export async function syncAndConfirm(
  appSessionId: string,
  eventId: string | null,
  reader: SessionEventReader = defaultReader,
): Promise<boolean> {
  for (let attempt = 0; attempt < CONFIRM_ATTEMPTS; attempt += 1) {
    await requestSessionSync(appSessionId, reader);
    if (eventId === null) return true;
    if (await hasSessionEvent(appSessionId, eventId)) return true;
    await sleep(CONFIRM_DELAY_MS);
  }
  return false;
}
