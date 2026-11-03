/**
 * Копии агента (#12): встроенный инструмент `agent` открывает дочернюю сессию
 * eve, её строка появляется в `agent_sessions`, а поток копии читается только
 * владельцем и только на чтение.
 */
import type { MessageStreamEvent } from "eve/client";
import { eq } from "drizzle-orm";
import { inject, beforeEach, describe, expect, test } from "vitest";

import { agentSessions, type User } from "../../lib/db/schema";
import { sleep } from "../../lib/sleep";
import { fetchApp } from "./support/app";
import { loginAs } from "./support/auth";
import {
  createSessionAs,
  eveClientAs,
  readStreamUntil,
  sendAndWait,
  waitForStoredEvents,
} from "./support/chat";
import { createDaytonaKey, createUser, db, resetDatabase } from "./support/db";
import { fakeSandbox } from "./support/fake-sandbox";
import { telegramStub } from "./support/telegram";

const appUrl = inject("appUrl");

beforeEach(async () => {
  await telegramStub.reset();
  await resetDatabase();
  await fakeSandbox.reset();
});

const AGENT_GREETING = '/tool agent {"message":"привет"}';
const AGENT_READ = '/tool agent {"message":"/tool read_file {\\"filePath\\":\\"/workspace/notes.txt\\"}"}';

function eventOf<T extends MessageStreamEvent["type"]>(
  events: readonly MessageStreamEvent[],
  type: T,
): Extract<MessageStreamEvent, { type: T }> | undefined {
  return events.find((event) => event.type === type) as
    | Extract<MessageStreamEvent, { type: T }>
    | undefined;
}

function eventsOf<T extends MessageStreamEvent["type"]>(
  events: readonly MessageStreamEvent[],
  type: T,
): Array<Extract<MessageStreamEvent, { type: T }>> {
  return events.filter((event) => event.type === type) as Array<
    Extract<MessageStreamEvent, { type: T }>
  >;
}

async function copiesOf(appSessionId: string) {
  return db().select().from(agentSessions).where(eq(agentSessions.appSessionId, appSessionId));
}

/** Открывает сессию с одним сообщением и возвращает поток корня. */
async function openSession(text: string): Promise<{
  user: User;
  appSessionId: string;
  events: MessageStreamEvent[];
}> {
  const user = await createUser();
  const { id } = await createSessionAs(user);
  const events = await sendAndWait(user, id, text);
  return { user, appSessionId: id, events };
}

describe("события и строка копии", () => {
  test("вызов agent объявляет копию, а её поток читает владелец", async () => {
    const { user, appSessionId, events } = await openSession(AGENT_GREETING);

    const started = eventOf(events, "task.started");
    expect(started?.data).toMatchObject({ kind: "agent", name: "agent" });
    const announced = eventOf(events, "agent.started");
    expect(announced?.data).toMatchObject({ name: "agent", sessionId: expect.any(String) });
    expect(announced?.data.streamPath).toContain(announced?.data.sessionId);

    const settled = eventOf(events, "task.settled");
    expect(settled?.data).toMatchObject({ status: "completed" });
    expect(JSON.stringify(settled?.data.output)).toContain("Эхо: привет");

    const rows = await copiesOf(appSessionId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      appSessionId,
      eveSessionId: announced?.data.sessionId,
      taskId: started?.data.taskId,
      callId: started?.data.callId,
      name: "agent",
    });

    // Владелец читает поток копии по `streamPath`: в нём ответ копии на
    // переданное сообщение.
    const cookie = await loginAs(user);
    const streamUrl = new URL(`${announced!.data.streamPath}?follow=false`, appUrl);
    const stream = await fetch(streamUrl, { headers: { cookie } });
    expect(stream.status).toBe(200);
    const streamed = (await stream.text())
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as { type: string; data?: { message?: string } });
    const streamedReply = streamed.filter((event) => event.type === "message.completed").at(-1);
    expect(streamedReply?.data?.message).toContain("привет");

    const client = await eveClientAs(user, appSessionId);
    const child = await readStreamUntil(
      client.sessions.attach(announced!.data.sessionId).stream({ follow: false }),
      "session.waiting",
      { timeoutMs: 20_000 },
    );
    const reply = child.filter((event) => event.type === "message.completed").at(-1);
    expect(reply?.data).toMatchObject({ message: "Эхо: привет" });
  }, 60_000);

  test("копия видит файл песочницы корня, песочница создаётся одна", async () => {
    await createDaytonaKey();

    const user = await createUser();
    const { id } = await createSessionAs(user);
    await fakeSandbox.seed(id, { "/workspace/notes.txt": "Файл корня виден копии\n" });

    const events = await sendAndWait(user, id, AGENT_READ);
    const announced = eventOf(events, "agent.started");
    expect(announced, events.map((item) => item.type).join(", ")).toBeDefined();
    expect((await fakeSandbox.counters()).created).toBe(1);

    const client = await eveClientAs(user, id);
    const child = await readStreamUntil(
      client.sessions.attach(announced!.data.sessionId).stream({ follow: false }),
      "session.waiting",
      { timeoutMs: 20_000 },
    );
    const result = eventsOf(child, "action.result").find(
      (event) => event.data.result.kind === "tool-result",
    );
    expect(result?.data.status).toBe("completed");
    expect(JSON.stringify(result?.data.result)).toContain("Файл корня виден копии");
    expect((await fakeSandbox.counters()).created).toBe(1);
  }, 90_000);

  test("два вызова в разных ходах дают две строки", async () => {
    const user = await createUser();
    const { id } = await createSessionAs(user);

    const first = await sendAndWait(user, id, AGENT_GREETING);
    const second = await sendAndWait(user, id, AGENT_GREETING);

    const rows = await copiesOf(id);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.eveSessionId)).size).toBe(2);
    expect(eventOf(first, "agent.started")?.data.sessionId).not.toBe(
      eventOf(second, "agent.started")?.data.sessionId,
    );
  }, 60_000);

  test("события копии сохраняются в истории сессии", async () => {
    const { user, appSessionId } = await openSession(AGENT_GREETING);

    const stored = await waitForStoredEvents(user, appSessionId, (items) =>
      items.some((item) => item.payload.type === "task.settled"),
    );
    const types = stored.map((item) => item.payload.type);
    expect(types).toEqual(
      expect.arrayContaining(["task.started", "agent.started", "task.settled"]),
    );
  }, 60_000);
});

interface OpenedCopy {
  readonly user: User;
  readonly appSessionId: string;
  readonly eveSessionId: string;
  readonly copySessionId: string;
  readonly copyRowId: string;
}

/** Сессия с одной копией: нужны идентификаторы корня и копии. */
async function openCopy(): Promise<OpenedCopy> {
  const { user, appSessionId, events } = await openSession(AGENT_GREETING);
  const cookie = await loginAs(user);
  const state = await fetchApp(`/api/sessions/${appSessionId}`, { headers: { cookie } });
  const body = (await state.json()) as { eveSessionId: string | null };
  if (body.eveSessionId === null) throw new Error("сессия eve не привязалась");

  const announced = eventOf(events, "agent.started");
  if (announced === undefined) throw new Error("agent.started не пришёл");
  const rows = await copiesOf(appSessionId);
  expect(rows).toHaveLength(1);

  return {
    user,
    appSessionId,
    eveSessionId: body.eveSessionId,
    copySessionId: announced.data.sessionId,
    copyRowId: rows[0]!.id,
  };
}

const SESSION_ROUTES = ["", "/cancel", "/clear", "/compact", "/reset"] as const;

describe("права на поток копии", () => {
  test("чужой получает 403 как на потоке корня, анонимный — 401", async () => {
    const { eveSessionId, copySessionId } = await openCopy();
    const stranger = await createUser();
    const cookie = await loginAs(stranger);

    const foreignRoot = await fetchApp(`/eve/v1/session/${eveSessionId}/stream`, {
      headers: { cookie },
    });
    const foreignCopy = await fetchApp(`/eve/v1/session/${copySessionId}/stream`, {
      headers: { cookie },
    });

    expect(foreignRoot.status).toBe(403);
    expect(foreignCopy.status).toBe(foreignRoot.status);
    expect(await foreignCopy.json()).toEqual(await foreignRoot.json());

    const anonymous = await fetchApp(`/eve/v1/session/${copySessionId}/stream`);
    expect(anonymous.status).toBe(401);
  }, 60_000);

  test("владелец читает поток копии, но не меняет её сессию", async () => {
    const { user, copySessionId } = await openCopy();
    const cookie = await loginAs(user);

    for (const route of SESSION_ROUTES) {
      const response = await fetchApp(`/eve/v1/session/${copySessionId}${route}`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ message: "лишнее" }),
      });
      expect(response.status, `POST ${route}`).toBe(403);
      expect(await response.json()).toMatchObject({ ok: false, code: "session_forbidden" });
    }

    const stream = await fetchApp(`/eve/v1/session/${copySessionId}/stream?follow=false`, {
      headers: { cookie },
    });
    expect(stream.status).toBe(200);
    await stream.body?.cancel();
  }, 60_000);

  test("неизвестный идентификатор: поток отказывает не позже 4 секунд, POST — сразу", async () => {
    const { user } = await openCopy();
    const cookie = await loginAs(user);

    const started = Date.now();
    const stream = await fetchApp("/eve/v1/session/wrun_unknown_id/stream", {
      headers: { cookie },
    });
    const waited = Date.now() - started;
    expect(stream.status).toBe(403);
    expect(waited).toBeGreaterThanOrEqual(2_500);
    expect(waited).toBeLessThan(4_000);

    const immediate = Date.now();
    const post = await fetchApp("/eve/v1/session/wrun_unknown_id", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ message: "чужое" }),
    });
    expect(post.status).toBe(403);
    expect(Date.now() - immediate).toBeLessThan(1_000);
  }, 60_000);

  test("поток ждёт появления строки копии вместо отказа", async () => {
    const { user, appSessionId, copySessionId, copyRowId } = await openCopy();
    const cookie = await loginAs(user);

    await db().delete(agentSessions).where(eq(agentSessions.id, copyRowId));

    let restored = false;
    const restore = (async () => {
      await sleep(1_000);
      await db().insert(agentSessions).values({
        appSessionId,
        eveSessionId: copySessionId,
        callId: "call_restored",
        name: "agent",
      });
      restored = true;
    })();

    const response = await fetchApp(`/eve/v1/session/${copySessionId}/stream?follow=false`, {
      headers: { cookie },
    });
    await restore;

    expect(restored).toBe(true);
    expect(response.status).toBe(200);
    await response.body?.cancel();
  }, 60_000);

  test("оператор видит инструмент agent в описании агента", async () => {
    const operator = await createUser({ isOperator: true });
    const { id } = await createSessionAs(operator);
    const client = await eveClientAs(operator, id);
    const info = await client.info();
    const names = info.tools.static.map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining(["agent", "bash", "read_file"]));
  }, 60_000);
});
