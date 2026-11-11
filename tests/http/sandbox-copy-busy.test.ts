/** P1 #63: вопрос одной копии не освобождает машину работающей второй копии. */
import { setTimeout as delay } from "node:timers/promises";
import { eq, inArray } from "drizzle-orm";
import type { MessageStreamEvent } from "eve/client";
import { conversationReducer, openConversationInputs } from "eve/react";
import { beforeEach, expect, test } from "vitest";

import { appSessions, bashJobs, queueEntries, sandboxes, sandboxWorkers, type User } from "../../lib/db/schema";
import type { SandboxStatus } from "../../lib/sandbox/status";
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

const KEY = "dtn_copy_busy_regression";
const COMMAND = "copy-busy-regression-command";
const STDOUT = "Вторая копия закончила команду без отмены\n";
const READ = '/tool read_file {"filePath":"/workspace/notes.txt"}';
const tool = (name: string, input: object) => `/tool ${name} ${JSON.stringify(input)}`;
const copy = (message: string, taskId?: string) => tool("agent", { message, taskId });

beforeEach(async () => {
  await resetDatabase();
  await fakeSandbox.reset();
});

function eventsOf<T extends MessageStreamEvent["type"]>(
  events: readonly MessageStreamEvent[],
  type: T,
): Array<Extract<MessageStreamEvent, { type: T }>> {
  return events.filter((event) => event.type === type) as Array<
    Extract<MessageStreamEvent, { type: T }>
  >;
}

function openInputs(events: readonly MessageStreamEvent[]) {
  const state = events.reduce(
    (state, event) => conversationReducer.reduce(state, event),
    conversationReducer.initial(),
  );
  return openConversationInputs(state);
}

async function status(user: User, appSessionId: string): Promise<SandboxStatus> {
  const response = await fetchApp(`/api/sessions/${appSessionId}/sandbox`, {
    headers: { cookie: await loginAs(user) },
  });
  expect(response.status).toBe(200);
  return response.json() as Promise<SandboxStatus>;
}

function expectRead(events: readonly MessageStreamEvent[], text: string) {
  const result = eventsOf(events, "action.result").find((event) =>
    event.data.result.kind === "tool-result" && event.data.result.toolName === "read_file",
  );
  expect(result?.data).toMatchObject({
    status: "completed",
    result: { output: { content: expect.stringContaining(text) } },
  });
}

/** Не ждёт iterator.return(): для диагностики читается только конечный HTTP-префикс. */
async function snapshot(sessionId: string, cookie: string): Promise<MessageStreamEvent[]> {
  return bounded(`snapshot ${sessionId}`, async () => {
    const response = await fetchApp(`/eve/v1/session/${sessionId}/stream?follow=false`, {
      headers: { cookie }, signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) throw new Error(`snapshot ${sessionId}: HTTP ${response.status}`);
    return (await response.text()).split("\n").filter((line) => line.trim())
      .map((line) => JSON.parse(line) as MessageStreamEvent);
  }, 3_500);
}

async function bounded<T>(label: string, operation: () => Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label}: timeout ${timeoutMs} ms`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function eventSummary(events: readonly MessageStreamEvent[]) {
  return events.map((event) => {
    const data = (event.data ?? {}) as Record<string, unknown>;
    return { type: event.type, at: event.meta.at, eventId: event.meta.id,
      turnId: data.turnId, stepIndex: data.stepIndex,
      on: data.on, taskId: data.taskId, status: data.status, sessionId: data.sessionId,
      requests: event.type === "input.requested" ? event.data.requests.map((request) =>
        ({ requestId: request.requestId, kind: request.kind })) : undefined,
      resolutions: event.type === "input.resolved" ? event.data.resolutions.map((resolution) =>
        ({ requestId: resolution.requestId, outcome: resolution.outcome })) : undefined };
  });
}

async function waitSnapshot(
  label: string,
  sessionId: string,
  cookie: string,
  predicate: (events: MessageStreamEvent[]) => boolean,
  timeoutMs = 10_000,
): Promise<MessageStreamEvent[]> {
  const deadline = Date.now() + timeoutMs;
  let last: MessageStreamEvent[] = [];
  while (Date.now() < deadline) {
    last = await snapshot(sessionId, cookie);
    if (predicate(last)) return last;
    await delay(Math.min(200, Math.max(0, deadline - Date.now())));
  }
  throw new Error(`${label}: timeout ${timeoutMs} ms; tail=${JSON.stringify(eventSummary(last.slice(-10)))}`);
}

test("relay вопроса не вытесняет занятую копию; после её завершения можно переключиться и ответить", async () => {
  await createDaytonaKey({ apiKey: KEY });
  // Ёмкости хватает двум машинам: блокировать должна именно занятость своей сессии.
  await fakeSandbox.setQuota(KEY, { cpu: 4, memoryGb: 8, diskGb: 64 });
  const user = await createUser();
  const first = await createSessionAs(user);
  const second = await createSessionAs(user);
  await fakeSandbox.seed(first.id, { "/workspace/notes.txt": "Сохранённый проект первой сессии" });
  await fakeSandbox.seed(second.id, { "/workspace/notes.txt": "Другая сессия получила место" });
  expectRead(await sendAndWait(user, first.id, READ), "Сохранённый проект первой сессии");

  const client = await eveClientAs(user, first.id);
  const cookie = await loginAs(user);
  const state = await fetchApp(`/api/sessions/${first.id}`, { headers: { cookie } });
  const { eveSessionId } = await state.json() as { eveSessionId: string };
  const root = client.sessions.attach(eveSessionId);
  const secondClient = await eveClientAs(user, second.id);
  let secondEveSessionId: string | undefined;
  const childIds: string[] = [];
  let phase = "opening-copies";

  try {
    // Фикстура вызывает один инструмент за шаг. Сначала открываем первую копию,
    // затем начинаем вторую и продолжаем первую по taskId, пока вторая работает.
    // До вопроса обычный steer не может случайно ответить на чужой запрос ввода.
    const greeting = await readStreamUntil(await root.send(copy("Первая копия")), "session.waiting");
    const firstCopy = eventsOf(greeting, "agent.started")[0]!;
    expect(firstCopy).toBeDefined();
    expect(firstCopy.data.taskId).toBeTypeOf("string");
    const firstChild = client.sessions.attach(firstCopy.data.sessionId);
    childIds.push(firstCopy.data.sessionId);
    const initialChild = await readStreamUntil(firstChild.stream({ follow: false }), "session.waiting");
    const before = await fakeSandbox.counters();
    const [original] = await db().select().from(sandboxes).where(eq(sandboxes.appSessionId, first.id));
    expect(original.state).toBe("started");

    // Настоящий bash, не stub action.result. Задерживается только внешний spawn;
    // результат приходит до штатного 30-секундного перехода в running.
    await fakeSandbox.rules.set([
      { match: COMMAND, delayMs: 25_000, stdout: STDOUT, exitCode: 0 },
    ]);
    const bashStart = await readStreamUntil(
      await root.send(copy(tool("bash", { command: COMMAND }))),
      "turn.waiting",
    );
    // Объявление копии может прийти уже после первой парковки корня на tasks.
    const announced = await waitForStoredEvents(user, first.id, (items) =>
      items.filter((item) => item.payload.type === "agent.started").length === 2,
    );
    const secondCopy = eventsOf(announced.map((item) => item.payload), "agent.started")
      .find((event) => event.data.sessionId !== firstCopy.data.sessionId)!;
    expect(secondCopy).toBeDefined();
    expect(eventsOf(bashStart, "turn.waiting")[0]?.data.on).toBe("tasks");
    expect(secondCopy.data.sessionId).not.toBe(firstCopy.data.sessionId);
    await expect.poll(async () => (await fakeSandbox.calls(first.id)).some((call) =>
      call.op === "spawn" && call.command?.includes(COMMAND),
    ), { timeout: 10_000, interval: 50 }).toBe(true);
    const secondChild = client.sessions.attach(secondCopy.data.sessionId);
    childIds.push(secondCopy.data.sessionId);

    const questionEvents = await readStreamUntil(
      await root.send(copy(tool("ask_question", { question: "Продолжить первую копию?" }), firstCopy.data.taskId)),
      "input.requested",
    );
    const requestEvent = eventsOf(questionEvents, "input.requested")[0]!;
    const stored = await waitForStoredEvents(user, first.id, (items) => {
      const requestIndex = items.findIndex((item) => item.payload.meta.id === requestEvent.meta.id);
      return requestIndex >= 0 && items.slice(requestIndex + 1).some((item) =>
        item.payload.type === "turn.waiting" && item.payload.data.on === "input",
      );
    });
    const [input] = openInputs(stored.map((item) => item.payload));
    expect(input).toBeDefined();
    expect(input.taskId).toBe(firstCopy.data.taskId);

    const unfinished = await readStreamUntil(secondChild.stream({ follow: false }), "session.waiting");
    expect(eventsOf(unfinished, "actions.requested").length).toBeGreaterThan(0);
    expect(eventsOf(unfinished, "action.result")).toHaveLength(0);
    expect(eventsOf(unfinished, "turn.completed")).toHaveLength(0);
    expect(await db().select().from(bashJobs).where(eq(bashJobs.appSessionId, first.id))).toHaveLength(0);

    const created = await secondClient.sessions.create({ message: READ });
    secondEveSessionId = created.session.state.sessionId;
    // MessageResponse открывает stream лениво. Здесь его не потребляем: после
    // bash проверяем конечные снимки, чтобы timeout не завис на iterator.return().
    phase = "expecting-own-session-busy";
    await expect.poll(() => status(user, second.id), { timeout: 10_000, interval: 50 }).toEqual({
      state: "queued", queue: { position: 1, total: 1, reason: "own_session_busy" },
    });
    expect(await status(user, first.id)).toEqual({ state: "started", queue: null });
    expect((await fakeSandbox.counters()).stopped).toBe(before.stopped);
    expect((await fakeSandbox.counters()).created).toBe(before.created);
    // Не позволяем истекшему таймеру скрыть неверно собранный сценарий:
    // очередь проверена именно ДО результата bash и появления bash_jobs.
    const stillWorking = await readStreamUntil(secondChild.stream({ follow: false }), "session.waiting");
    expect(eventsOf(stillWorking, "action.result")).toHaveLength(0);
    expect(await db().select().from(bashJobs).where(eq(bashJobs.appSessionId, first.id))).toHaveLength(0);

    phase = "awaiting-bash-completion";
    const finished = await waitSnapshot(phase, secondCopy.data.sessionId, cookie,
      (events) => events.some((event) => event.type === "session.waiting"), 40_000);
    // У fakeProcess.kill результат 137: exit 0 и полный stdout подтверждают,
    // что незавершённая команда пережила запрос на переключение без отмены.
    expect(eventsOf(finished, "action.result")[0]?.data).toMatchObject({
      status: "completed", result: { output: { status: "completed", exitCode: 0, stdout: STDOUT } },
    });
    expect(eventsOf(finished, "turn.cancelled")).toHaveLength(0);
    phase = "awaiting-task-settled";
    const settled = await waitForStoredEvents(user, first.id, (items) => items.some((item) =>
      item.payload.type === "task.settled" && item.payload.data.taskId === secondCopy.data.taskId &&
      item.payload.data.status === "completed",
    ));
    expect(openInputs(settled.map((item) => item.payload)).map((item) => item.request.requestId))
      .toEqual([input.request.requestId]);
    // task.settled пробуждает модель корня; повторный hold в eve 0.83.0
    // публикует on: tasks даже при открытом relay-вопросе. Не требуем нового
    // on: input: проверяем исходный контракт — другая сессия получает место.
    phase = "awaiting-second-session-after-bash";
    const waiting = await waitSnapshot(phase, secondEveSessionId, cookie,
      (events) => events.some((event) => event.type === "session.waiting"));
    expectRead(waiting, "Другая сессия получила место");
    expect(await status(user, first.id)).toEqual({ state: "stopped", queue: null });
    expect(await status(user, second.id)).toEqual({ state: "started", queue: null });
    expect((await fakeSandbox.counters()).stopped).toBe(before.stopped + 1);

    // Ответ идёт через корень, а не запрещённый POST в сессию копии.
    phase = "answering-first-copy";
    const answer = await fetchApp(`/eve/v1/session/${eveSessionId}`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" }, signal: AbortSignal.timeout(5_000),
      body: JSON.stringify({ inputResponses: [{ requestId: input.request.requestId, text: "Продолжай" }] }),
    });
    expect(answer.ok).toBe(true);
    phase = "awaiting-first-copy-answer";
    const resumed = (await waitSnapshot(phase, firstCopy.data.sessionId, cookie,
      (events) => events.slice(initialChild.length).some((event) => event.type === "session.waiting")))
      .slice(initialChild.length);
    expect(eventsOf(resumed, "action.result")[0]?.data).toMatchObject({
      status: "completed", result: { output: { status: "answered", answer: "Продолжай" } },
    });
    expect(eventsOf(resumed, "turn.cancelled")).toHaveLength(0);
    phase = "awaiting-root-session-waiting";
    await waitForStoredEvents(user, first.id, (items) => items.some((item) =>
      item.seq > stored.at(-1)!.seq && item.payload.type === "session.waiting",
    ));
    phase = "reading-retained-project";
    const previous = await snapshot(eveSessionId, cookie);
    await root.send(READ);
    const retained = await waitSnapshot(phase, eveSessionId, cookie,
      (events) => events.slice(previous.length).some((event) => event.type === "session.waiting"));
    expectRead(retained.slice(previous.length), "Сохранённый проект первой сессии");
    const [restored] = await db().select().from(sandboxes).where(eq(sandboxes.appSessionId, first.id));
    expect(restored).toMatchObject({ daytonaSandboxId: original.daytonaSandboxId, state: "started" });
  } catch (error) {
    // Снимаем состояние ДО cancel, иначе отмена уничтожит причину зависания.
    // Только идентификаторы, границы и состояния: cookie/ключи/тексты не печатаем.
    const observations = await Promise.allSettled([
      ...[eveSessionId, ...childIds, ...(secondEveSessionId ? [secondEveSessionId] : [])]
        .map(async (id) => ({ sessionId: id, events: eventSummary(await snapshot(id, cookie)) })),
      bounded("database diagnostic", async () => ({
        roots: await db().select({ id: appSessions.id, eveSessionId: appSessions.eveSessionId,
          state: appSessions.sandboxWorkState, turnId: appSessions.sandboxWorkTurnId,
          eventId: appSessions.sandboxWorkEventId }).from(appSessions)
          .where(inArray(appSessions.id, [first.id, second.id])),
        workers: await db().select().from(sandboxWorkers).where(eq(sandboxWorkers.appSessionId, first.id)),
        queue: await db().select().from(queueEntries).where(inArray(queueEntries.appSessionId, [first.id, second.id])),
        machines: await db().select().from(sandboxes).where(inArray(sandboxes.appSessionId, [first.id, second.id])),
        jobs: await db().select({ jobId: bashJobs.jobId, status: bashJobs.status,
          exitCode: bashJobs.exitCode }).from(bashJobs).where(eq(bashJobs.appSessionId, first.id)),
        counters: await fakeSandbox.counters(),
      }), 3_500),
    ]);
    console.error("[sandbox-copy-busy]", JSON.stringify({ phase, observations: observations.map((item) =>
      item.status === "fulfilled" ? item.value : { error: String(item.reason) }),
    }));
    throw new Error(`[sandbox-copy-busy] ${phase}`, { cause: error });
  } finally {
    // При красном тесте закрываем обе настоящие eve-сессии до очистки общей БД.
    const cancellation = await Promise.allSettled([
      bounded("cancel root", () => root.cancel({ signal: AbortSignal.timeout(3_000) }), 3_500),
      ...(secondEveSessionId ? [bounded("cancel queued session", () =>
        secondClient.sessions.attach(secondEveSessionId!).cancel({ signal: AbortSignal.timeout(3_000) }), 3_500)] : []),
    ]);
    const cleanup = await Promise.allSettled([
      waitSnapshot("root cleanup", eveSessionId, cookie,
        (events) => events.at(-1)?.type === "session.waiting", 5_000),
      ...(secondEveSessionId ? [waitSnapshot("queued session cleanup", secondEveSessionId, cookie,
        (events) => events.at(-1)?.type === "session.waiting", 5_000)] : []),
    ]);
    const failures = [...cancellation, ...cleanup].filter((item) => item.status === "rejected");
    if (failures.length > 0) {
      console.error("[sandbox-copy-busy] cleanup", failures.map((item) => String(item.reason)));
    }
    await fakeSandbox.rules.clear();
  }
}, 90_000);
