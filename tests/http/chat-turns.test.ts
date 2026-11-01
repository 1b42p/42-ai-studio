/** Ход сессии: отмена, поправка и восстановление посреди хода. */
import { beforeEach, describe, expect, test } from "vitest";
import type { MessageStreamEvent } from "eve/client";

import { fetchApp } from "./support/app";
import { loginAs } from "./support/auth";
import {
  createSessionAs,
  eveClientAs,
  readStreamUntil,
  sendAndWait,
  waitForStoredEvents,
  type StoredEventsResponse,
} from "./support/chat";
import { createUser, resetDatabase } from "./support/db";
import { telegramStub } from "./support/telegram";

beforeEach(async () => {
  await telegramStub.reset();
  await resetDatabase();
});

function lastCompleted(events: readonly MessageStreamEvent[]): string | undefined {
  const completed = events.filter((event) => event.type === "message.completed").at(-1);
  return (completed?.data as { message?: string } | undefined)?.message;
}

async function storedState(
  user: Awaited<ReturnType<typeof createUser>>,
  appSessionId: string,
): Promise<{ events: StoredEventsResponse["events"]; cursor: number }> {
  const cookie = await loginAs(user);
  const [state, events] = await Promise.all([
    fetchApp(`/api/sessions/${appSessionId}`, { headers: { cookie } }),
    fetchApp(`/api/sessions/${appSessionId}/events`, { headers: { cookie } }),
  ]);
  const { streamCursor } = (await state.json()) as { streamCursor: number };
  const body = (await events.json()) as StoredEventsResponse;
  return { events: body.events, cursor: streamCursor };
}

describe("ход сессии", () => {
  test("«Стоп» отменяет ход, затем сессия принимает следующее сообщение", async () => {
    const user = await createUser();
    const { id } = await createSessionAs(user);
    const client = await eveClientAs(user, id);

    const created = await client.sessions.create({ message: "/slow 15 долго" });
    const streamed = readStreamUntil(created.response, "session.waiting", { timeoutMs: 15_000 });

    await waitForStoredEvents(
      user,
      id,
      (events) => events.some((event) => event.payload.type === "message.received"),
      { timeoutMs: 5000 },
    );

    const cancelled = await created.session.cancel();
    expect(cancelled.status).toBe("accepted");

    const events = await streamed;
    expect(events.map((event) => event.type)).toContain("turn.cancelled");
    expect(events.at(-1)?.type).toBe("session.waiting");

    const next = await sendAndWait(user, id, "следующее");
    expect(lastCompleted(next)).toBe("Эхо: следующее");
  }, 30_000);

  test("поправка посреди хода заменяет ответ и оставляет один ход", async () => {
    const user = await createUser();
    const { id } = await createSessionAs(user);
    const client = await eveClientAs(user, id);

    const created = await client.sessions.create({ message: "/slow 8 первое" });
    const streamed = readStreamUntil(created.response, "session.waiting", { timeoutMs: 25_000 });

    await waitForStoredEvents(
      user,
      id,
      (events) => events.some((event) => event.payload.type === "message.received"),
      { timeoutMs: 5000 },
    );

    // Политика по умолчанию — steer: поправка к текущему ходу.
    await client.sessions.attach(created.session.state.sessionId).send("второе");

    const events = await streamed;
    expect(lastCompleted(events)).toBe("Эхо: второе");
    expect(events.filter((event) => event.type === "message.received")).toHaveLength(2);
    expect(events.filter((event) => event.type === "turn.completed")).toHaveLength(1);
  }, 35_000);

  test("восстановление посреди хода дочитывает поток без пропусков и повторов", async () => {
    const user = await createUser();
    const { id } = await createSessionAs(user);
    const client = await eveClientAs(user, id);

    const created = await client.sessions.create({ message: "/slow 5 привет" });
    const live = readStreamUntil(created.response, "session.waiting", { timeoutMs: 20_000 });

    await waitForStoredEvents(
      user,
      id,
      (events) => events.some((event) => event.payload.type === "message.received"),
      { timeoutMs: 5000 },
    );

    const { events: stored, cursor } = await storedState(user, id);
    const eveSessionId = created.session.state.sessionId;

    const tail: MessageStreamEvent[] = [];
    for await (const event of client.sessions
      .attach(eveSessionId)
      .stream({ startIndex: cursor, follow: true })) {
      tail.push(event);
      if (event.type === "session.waiting") break;
    }

    const merged = [...stored.map((event) => event.payload as MessageStreamEvent), ...tail];
    const ids = merged.map((event) => event.meta?.id).filter((value): value is string => value !== undefined);
    expect(new Set(ids).size).toBe(ids.length);

    const fromZero: MessageStreamEvent[] = [];
    for await (const event of client.sessions
      .attach(eveSessionId)
      .stream({ startIndex: 0, follow: false })) {
      fromZero.push(event);
    }
    expect(ids).toEqual(fromZero.map((event) => event.meta?.id));
    expect(lastCompleted(merged)).toBe("Эхо: привет");

    await live;
  }, 30_000);
});
