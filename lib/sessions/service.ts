/**
 * Доступ к сессиям приложения в базе: создание, поиск, привязка к сессии eve,
 * сохранённые события. Здесь только SQL: правила доступа и HTTP живут выше.
 */
import { and, asc, eq, gt, isNull, lt, or, sql } from "drizzle-orm";

import { getDb, type Database } from "../db/client";
import {
  appSessions,
  sessionEvents,
  type AppSession,
  type SessionEvent,
} from "../db/schema";
import { titleFromEvents, titleSearchKey, type TitleSourceEvent } from "./title";

/** Сколько секунд после начала создания сессии eve разрешено её привязать. */
export const SESSION_START_WINDOW_MS = 60_000;

/** Событие, сохранённое в базе, в форме ответа API. */
export interface StoredSessionEvent {
  readonly seq: number;
  readonly payload: unknown;
}

export async function createAppSession(userId: string): Promise<AppSession> {
  const [row] = await getDb()
    .insert(appSessions)
    .values({ userId })
    .returning();
  return row;
}

/** Сессия по идентификатору приложения, без проверки владельца. */
export async function findAppSessionById(id: string): Promise<AppSession | null> {
  const [row] = await getDb().select().from(appSessions).where(eq(appSessions.id, id)).limit(1);
  return row ?? null;
}

/** Сессия этого пользователя; чужая и несуществующая неразличимы. */
export async function findAppSessionForUser(
  id: string,
  userId: string,
): Promise<AppSession | null> {
  const [row] = await getDb()
    .select()
    .from(appSessions)
    .where(and(eq(appSessions.id, id), eq(appSessions.userId, userId)))
    .limit(1);
  return row ?? null;
}

/** Сессия по идентификатору eve; нужна хукам и проверке владельца. */
export async function findAppSessionByEveId(eveSessionId: string): Promise<AppSession | null> {
  const [row] = await getDb()
    .select()
    .from(appSessions)
    .where(eq(appSessions.eveSessionId, eveSessionId))
    .limit(1);
  return row ?? null;
}

/**
 * Отмечает начало создания сессии eve одной атомарной записью: `now()`
 * выставляется, только если сессия ещё не привязана и прошлая попытка старше
 * 60 секунд. `null` — условия не выполнены (уже начата или идёт создание).
 */
export async function claimSessionStart(
  appSessionId: string,
  userId: string,
): Promise<AppSession | null> {
  const [row] = await getDb()
    .update(appSessions)
    .set({ startRequestedAt: sql`now()` })
    .where(
      and(
        eq(appSessions.id, appSessionId),
        eq(appSessions.userId, userId),
        isNull(appSessions.eveSessionId),
        or(
          isNull(appSessions.startRequestedAt),
          lt(appSessions.startRequestedAt, sql`now() - interval '60 seconds'`),
        ),
      ),
    )
    .returning();
  return row ?? null;
}

/**
 * Привязывает сессию eve к сессии приложения, если та ещё свободна и
 * принадлежит пользователю. `false` — привязка уже случилась иначе.
 */
export async function bindAppSession(
  appSessionId: string,
  userId: string,
  eveSessionId: string,
): Promise<boolean> {
  const [row] = await getDb()
    .update(appSessions)
    .set({ eveSessionId })
    .where(
      and(
        eq(appSessions.id, appSessionId),
        eq(appSessions.userId, userId),
        isNull(appSessions.eveSessionId),
      ),
    )
    .returning({ id: appSessions.id });
  return row !== undefined;
}

/** Сессия пользователя, создание которой начато не дольше 60 секунд назад. */
export async function findStartingAppSession(userId: string): Promise<AppSession | null> {
  const [row] = await getDb()
    .select()
    .from(appSessions)
    .where(
      and(
        eq(appSessions.userId, userId),
        isNull(appSessions.eveSessionId),
        gt(appSessions.startRequestedAt, sql`now() - interval '60 seconds'`),
      ),
    )
    .orderBy(sql`${appSessions.startRequestedAt} desc`)
    .limit(1);
  return row ?? null;
}

export interface ReadSessionEventsResult {
  readonly events: StoredSessionEvent[];
  /** `stream_cursor` на момент чтения. */
  readonly cursor: number;
}

/**
 * Читает события после `after` по возрастанию `seq` и курсор потока на момент
 * чтения — одной транзакцией `repeatable read`, чтобы оба запроса видели один
 * снимок и ответ был согласован сам с собой. `null` — сессии нет.
 */
export async function readSessionEvents(
  appSessionId: string,
  options: { after: number; limit: number },
): Promise<ReadSessionEventsResult | null> {
  return getDb().transaction(
    async (tx) => {
      const [session] = await tx
        .select({ streamCursor: appSessions.streamCursor })
        .from(appSessions)
        .where(eq(appSessions.id, appSessionId))
        .limit(1);
      if (session === undefined) return null;

      const events = await tx
        .select({ seq: sessionEvents.seq, payload: sessionEvents.payload })
        .from(sessionEvents)
        .where(
          and(eq(sessionEvents.appSessionId, appSessionId), gt(sessionEvents.seq, options.after)),
        )
        .orderBy(asc(sessionEvents.seq))
        .limit(options.limit);

      return { events, cursor: session.streamCursor };
    },
    { isolationLevel: "repeatable read" },
  );
}

/**
 * Ставит название один раз, в той же транзакции, что и курсор потока.
 * Повторный вызов и уже заполненное название ничего не меняют.
 */
export async function setTitleIfEmpty(
  tx: Pick<Database, "update">,
  appSessionId: string,
  events: readonly TitleSourceEvent[],
): Promise<void> {
  const title = titleFromEvents(events);
  if (title === null) return;
  await tx
    .update(appSessions)
    .set({ title, titleSearch: titleSearchKey(title) })
    .where(and(eq(appSessions.id, appSessionId), isNull(appSessions.title)));
}

/** Сохранено ли событие с этим `meta.id`. */
export async function hasSessionEvent(
  appSessionId: string,
  eventId: string,
): Promise<boolean> {
  const [row] = await getDb()
    .select({ id: sessionEvents.id })
    .from(sessionEvents)
    .where(and(eq(sessionEvents.appSessionId, appSessionId), eq(sessionEvents.eventId, eventId)))
    .limit(1);
  return row !== undefined;
}

export type { AppSession, SessionEvent };
