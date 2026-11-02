/**
 * Помощники HTTP-тестов чата. Имена обязательны для следующих тикетов:
 * `createSessionAs`, `eveClientAs`, `readStreamUntil`, `waitForStoredEvents`,
 * `sendAndWait`.
 */
import { Client, type MessageStreamEvent } from "eve/client";
import type { UserContent } from "ai";
import { inArray } from "drizzle-orm";
import { inject } from "vitest";

import { loadConfig } from "../../../lib/config";
import { media, type User } from "../../../lib/db/schema";
import { sleep } from "../../../lib/sleep";
import { fetchApp } from "./app";
import { loginAs } from "./auth";
import { db } from "./db";

/** Ответ приложения со списком сохранённых событий. */
export interface StoredEventsResponse {
  readonly events: Array<{ seq: number; payload: MessageStreamEvent }>;
  readonly cursor: number;
}

/** Создаёт сессию приложения от имени пользователя. */
export async function createSessionAs(
  user: User,
  options: { baseUrl?: string } = {},
): Promise<{ id: string }> {
  const cookie = await loginAs(user);
  const response = await fetch(new URL("/api/sessions", options.baseUrl ?? inject("appUrl")), {
    method: "POST",
    headers: { cookie },
    redirect: "manual",
  });
  if (response.status !== 201) {
    throw new Error(`POST /api/sessions вернул ${response.status}: ${await response.text()}`);
  }
  return (await response.json()) as { id: string };
}

/** Клиент eve с cookie пользователя и заголовком сессии приложения. */
export async function eveClientAs(
  user: User,
  appSessionId: string,
  options: { baseUrl?: string } = {},
): Promise<Client> {
  const cookie = await loginAs(user);
  return new Client({
    host: options.baseUrl ?? inject("appUrl"),
    redirect: "manual",
    headers: {
      cookie,
      "x-studio-session-id": appSessionId,
    },
  });
}

export interface ReadStreamOptions {
  /** Предел ожидания, по умолчанию 30 секунд. */
  timeoutMs?: number;
}

function timeout(ms: number, type: string, events: readonly MessageStreamEvent[]): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => {
      reject(
        new Error(
          `событие ${type} не пришло за ${ms} мс; получено: ${events.map((item) => item.type).join(", ")}`,
        ),
      );
    }, ms);
  });
}

/**
 * Читает поток событий, пока не придёт событие `type` или не истечёт таймаут.
 * Возвращает все прочитанные события, включая искомое.
 */
export async function readStreamUntil(
  stream: AsyncIterable<MessageStreamEvent>,
  type: string,
  options: ReadStreamOptions = {},
): Promise<MessageStreamEvent[]> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const events: MessageStreamEvent[] = [];
  const iterator = stream[Symbol.asyncIterator]();
  const deadline = Date.now() + timeoutMs;

  try {
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(
          `событие ${type} не пришло за ${timeoutMs} мс; получено: ${events.map((item) => item.type).join(", ")}`,
        );
      }
      const next = await Promise.race([iterator.next(), timeout(remaining, type, events)]);
      if (next.done === true) return events;
      events.push(next.value);
      if (next.value.type === type) return events;
    }
  } finally {
    await iterator.return?.();
  }
}

export interface WaitForStoredEventsOptions {
  /** Предел ожидания, по умолчанию 10 секунд. */
  timeoutMs?: number;
}

/** Опрашивает `GET /api/sessions/:id/events`, пока условие не выполнится. */
export async function waitForStoredEvents(
  user: User,
  appSessionId: string,
  predicate: (events: StoredEventsResponse["events"]) => boolean,
  options: WaitForStoredEventsOptions = {},
): Promise<StoredEventsResponse["events"]> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const cookie = await loginAs(user);
  const deadline = Date.now() + timeoutMs;
  let last: StoredEventsResponse["events"] = [];

  while (Date.now() < deadline) {
    const response = await fetchApp(`/api/sessions/${appSessionId}/events`, {
      headers: { cookie },
    });
    if (response.status === 200) {
      const body = (await response.json()) as StoredEventsResponse;
      last = body.events;
      if (predicate(last)) return last;
    }
    await sleep(200);
  }

  throw new Error(
    `условие по сохранённым событиям не выполнилось за ${timeoutMs} мс; ` +
      `событий: ${last.length}, последние: ${last.slice(-5).map((item) => item.payload.type).join(", ")}`,
  );
}

/**
 * Отправляет сообщение: создаёт сессию eve первым сообщением, если её ещё нет,
 * и дочитывает поток хода до `session.waiting`.
 */
export async function sendAndWait(
  user: User,
  appSessionId: string,
  text: string,
): Promise<MessageStreamEvent[]> {
  return sendContentAndWait(user, appSessionId, text);
}

/**
 * Отправляет готовое содержимое (текст или текст с файловыми частями) и ждёт
 * конца хода. Общий путь для `sendAndWait` и `sendWithFiles`.
 */
export async function sendContentAndWait(
  user: User,
  appSessionId: string,
  content: string | UserContent,
  options: { baseUrl?: string } = {},
): Promise<MessageStreamEvent[]> {
  const client = await eveClientAs(user, appSessionId, options);
  const cookie = await loginAs(user);
  const stateResponse = await fetch(
    new URL(`/api/sessions/${appSessionId}`, options.baseUrl ?? inject("appUrl")),
    { headers: { cookie }, redirect: "manual" },
  );
  if (stateResponse.status !== 200) {
    throw new Error(`GET /api/sessions/${appSessionId} вернул ${stateResponse.status}`);
  }
  const state = (await stateResponse.json()) as { eveSessionId: string | null };

  const response =
    state.eveSessionId === null
      ? (await client.sessions.create({ message: content })).response
      : await client.sessions.attach(state.eveSessionId).send(content);

  return readStreamUntil(response, "session.waiting");
}

/**
 * Отправляет сообщение с файлами (#9): файловые части собираются по строкам
 * `media`, `data` — адрес `fileUrl` из ответа `POST /api/uploads`.
 */
export async function sendWithFiles(
  user: User,
  appSessionId: string,
  text: string,
  mediaIds: readonly string[],
  options: { baseUrl?: string } = {},
): Promise<MessageStreamEvent[]> {
  const rows =
    mediaIds.length === 0
      ? []
      : await db()
          .select()
          .from(media)
          .where(inArray(media.id, [...mediaIds]));
  const byId = new Map(rows.map((row) => [row.id, row]));
  const appUrl = loadConfig().appUrl;

  const content: UserContent = [
    ...(text.length === 0 ? [] : [{ type: "text" as const, text }]),
    ...mediaIds.map((id) => {
      const row = byId.get(id);
      if (row === undefined) throw new Error(`строки media ${id} нет`);
      return {
        type: "file" as const,
        data: `${appUrl}/api/media/${id}`,
        mediaType: row.contentType,
        filename: row.originalName,
      };
    }),
  ];

  return sendContentAndWait(user, appSessionId, content, options);
}
