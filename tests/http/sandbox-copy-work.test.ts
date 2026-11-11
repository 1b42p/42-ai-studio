import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { HookContext, HookEvent } from "eve/hooks";

import sandboxQueueHook from "../../agent/hooks/sandbox-queue";
import { getSqlClient } from "../../lib/db/client";
import { agentSessions, appSessions, sandboxTaskCalls, sandboxWorkers, sessionEvents } from "../../lib/db/schema";
import { sessionIsBusy, turnIsBusy } from "../../lib/sandbox/busy";
import { recordSandboxCopyWork } from "../../lib/sandbox/copy-work";
import * as copyWork from "../../lib/sandbox/copy-work";
import { emptyReading } from "../../lib/sandbox/job-directory";
import * as maintenance from "../../lib/sandbox/maintenance";
import * as queueState from "../../lib/sandbox/queue-state";
import * as waitGeneration from "../../lib/sandbox/wait-generation";
import * as taskWaits from "../../lib/sandbox/task-waits";
import { createUser, db, resetDatabase } from "./support/db";

beforeEach(resetDatabase);
afterEach(() => vi.restoreAllMocks());

async function root() {
  const user = await createUser();
  const [session] = await db().insert(appSessions).values({
    userId: user.id, eveSessionId: randomUUID(), sandboxWorkState: "input",
  }).returning();
  return { ...session, eveSessionId: session.eveSessionId! };
}

async function worker(eveSessionId: string) {
  const [row] = await db().select().from(sandboxWorkers)
    .where(eq(sandboxWorkers.eveSessionId, eveSessionId));
  return row;
}

test("input одной копии и ожидающий корень не освобождают активную соседнюю копию", async () => {
  const session = await root();
  const first = randomUUID();
  const second = randomUUID();
  const readJobDirectory = vi.fn(async () => emptyReading());
  const machine = { state: "stopped", readJobDirectory };

  await recordSandboxCopyWork(session.eveSessionId, first, "active", "first", "a", 0);
  await recordSandboxCopyWork(session.eveSessionId, second, "active", "second", "b", 0);
  await recordSandboxCopyWork(session.eveSessionId, first, "input", "first", "c", 0);
  expect(await sessionIsBusy(session.id, machine)).toBe(true);
  expect(await worker(first)).toMatchObject({ state: "input", turnId: "first" });
  expect(await worker(second)).toMatchObject({ state: "active", turnId: "second" });

  await recordSandboxCopyWork(session.eveSessionId, second, "input", "second", "d", 0);
  expect(await sessionIsBusy(session.id, machine)).toBe(false);
  await recordSandboxCopyWork(session.eveSessionId, first, "active", "first", "e", 0);
  expect(await sessionIsBusy(session.id, machine)).toBe(true);
  await recordSandboxCopyWork(session.eveSessionId, first, "idle", "first", "f", 0);
  expect(await sessionIsBusy(session.id, machine)).toBe(false);
  expect(readJobDirectory).not.toHaveBeenCalled();
});

test("завершённая чужая копия и другой корень не влияют на активную копию", async () => {
  const firstRoot = await root();
  const secondRoot = await root();
  const copy = randomUUID();
  await recordSandboxCopyWork(firstRoot.eveSessionId, copy, "active", "turn", "a", 1);
  await recordSandboxCopyWork(secondRoot.eveSessionId, copy, "idle", "turn", "b", 1);
  const machine = { readJobDirectory: async () => emptyReading() };
  expect(await sessionIsBusy(firstRoot.id, machine)).toBe(true);
  expect(await sessionIsBusy(secondRoot.id, machine)).toBe(false);
  expect(await worker(copy)).toMatchObject({ appSessionId: firstRoot.id, state: "active" });
});

test("поздний terminal старого turnId не затирает новый active", async () => {
  const session = await root();
  const copy = randomUUID();
  await recordSandboxCopyWork(session.eveSessionId, copy, "active", "old", "a", 0);
  await recordSandboxCopyWork(session.eveSessionId, copy, "idle", "old", "b", 0);
  await recordSandboxCopyWork(session.eveSessionId, copy, "active", "new", "c", 1);
  await recordSandboxCopyWork(session.eveSessionId, copy, "idle", "old", "d", 0);
  // Даже ошибочно совпавшая sequence не разрешает terminal чужого turnId.
  await recordSandboxCopyWork(session.eveSessionId, copy, "idle", "old", "e", 1);
  expect(await worker(copy)).toMatchObject({
    state: "active", turnId: "new", turnSequence: 1, eventId: "c",
  });
});

test("старый active не оживляет завершённый или более новый ход", async () => {
  const session = await root();
  const copy = randomUUID();
  await recordSandboxCopyWork(session.eveSessionId, copy, "active", "old", "a", 0);
  await recordSandboxCopyWork(session.eveSessionId, copy, "idle", "old", "b", 0);
  await recordSandboxCopyWork(session.eveSessionId, copy, "active", "old", "c", 0);
  await recordSandboxCopyWork(session.eveSessionId, copy, "input", "old", "late-input", 0);
  expect(await worker(copy)).toMatchObject({ state: "idle", eventId: "b" });

  await recordSandboxCopyWork(session.eveSessionId, copy, "active", "new", "d", 1);
  await recordSandboxCopyWork(session.eveSessionId, copy, "input", "new", "e", 1);
  await recordSandboxCopyWork(session.eveSessionId, copy, "active", "old", "f", 0);
  expect(await worker(copy)).toMatchObject({ state: "input", turnId: "new", eventId: "e" });
  await recordSandboxCopyWork(session.eveSessionId, copy, "active", "new", "g", 1);
  expect(await worker(copy)).toMatchObject({ state: "active", turnId: "new", eventId: "g" });
});

test("terminal без начала хода сохраняется как защита от позднего active", async () => {
  const session = await root();
  const copy = randomUUID();
  await recordSandboxCopyWork(session.eveSessionId, copy, "idle", "turn", "end", 3);
  await recordSandboxCopyWork(session.eveSessionId, copy, "active", "turn", "late", 3);
  expect(await worker(copy)).toMatchObject({ state: "idle", eventId: "end", turnSequence: 3 });
  await recordSandboxCopyWork(session.eveSessionId, copy, "active", "next", "next", 4);
  expect(await worker(copy)).toMatchObject({ state: "active", turnId: "next", turnSequence: 4 });
});

test("active фиксируется и освобождает транзакционный барьер до ожидания maintenance", async () => {
  const session = await root();
  const copy = randomUUID();
  let finish!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => { finish = resolve; });
  const waiting = new Promise<void>((resolve) => { entered = resolve; });
  const wait = vi.spyOn(maintenance, "waitForSandboxMaintenance").mockImplementation(async (id) => {
    entered();
    await gate;
    expect(id).toBe(session.id);
  });
  let finished = false;
  const work = recordSandboxCopyWork(session.eveSessionId, copy, "active", "turn", "a", 0)
    .then(() => { finished = true; });
  try {
    await waiting;
    expect(await worker(copy)).toMatchObject({ state: "active" });
    await getSqlClient().begin(async (tx) => {
      const [lock] = await tx`
        select pg_try_advisory_xact_lock(20261111, hashtext(${session.id})) as acquired
      `;
      expect(lock.acquired).toBe(true);
    });
    expect(finished).toBe(false);
  } finally {
    finish();
    await work;
  }
  expect(wait).toHaveBeenCalledOnce();
  await recordSandboxCopyWork(session.eveSessionId, copy, "input", "turn", "b", 0);
  await recordSandboxCopyWork(session.eveSessionId, copy, "idle", "turn", "c", 0);
  expect(wait).toHaveBeenCalledOnce();
});

test("неизвестный корень не создаёт worker; удаление приложения удаляет его worker", async () => {
  const copy = randomUUID();
  await recordSandboxCopyWork(randomUUID(), copy, "active", "turn");
  expect(await worker(copy)).toBeUndefined();
  const session = await root();
  await recordSandboxCopyWork(session.eveSessionId, copy, "active", "turn");
  await db().delete(appSessions).where(eq(appSessions.id, session.id));
  expect(await worker(copy)).toBeUndefined();
});

function copyContext(rootSessionId: string, sessionId: string): HookContext {
  return {
    session: {
      id: sessionId,
      auth: { current: null, initiator: null },
      turn: { id: "new", sequence: 2 },
      parent: { rootSessionId, sessionId: rootSessionId, callId: "call", turn: { id: "parent", sequence: 0 } },
    },
    agent: { name: "agent" }, channel: {}, cancel: vi.fn(),
    getSandbox: vi.fn(),
  } as HookContext;
}

test.each(["turn.completed", "turn.failed", "turn.cancelled", "input.resolved"] as const)(
  "хук %s сохраняет координаты старого события, а не нового хода контекста",
  async (type) => {
    const session = await root();
    const copy = randomUUID();
    await recordSandboxCopyWork(session.eveSessionId, copy, "active", "new", "start", 2);
    const context = copyContext(session.eveSessionId, copy);
    const event = {
      type, data: { turnId: "old", sequence: 1 }, meta: { id: "late" },
    } as HookEvent<typeof type>;
    const remove = vi.spyOn(queueState, "removeSandboxQueueEntry").mockResolvedValue(undefined);
    const rootWork = vi.spyOn(maintenance, "recordSandboxWork").mockResolvedValue(undefined);
    // У всех четырёх обработчиков одна публичная сигнатура HookEvent/HookContext.
    const handler = sandboxQueueHook.events![type] as (
      event: HookEvent, context: HookContext,
    ) => Promise<void>;
    await handler(event, context);
    expect(await worker(copy)).toMatchObject({
      state: "active", turnId: "new", turnSequence: 2, eventId: "start",
    });
    expect(context.cancel).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(rootWork).not.toHaveBeenCalled();
  },
);

test.each(["session.waiting", "session.failed", "session.completed"] as const)(
  "хук %s освобождает только копию и не удаляет очередь корня",
  async (type) => {
    const context = copyContext("root", "child");
    const record = vi.spyOn(copyWork, "recordSandboxCopyWork").mockResolvedValue(undefined);
    const remove = vi.spyOn(queueState, "removeSandboxQueueEntry").mockResolvedValue(undefined);
    const rootWork = vi.spyOn(maintenance, "recordSandboxWork").mockResolvedValue(undefined);
    const handler = sandboxQueueHook.events![type] as (
      event: HookEvent, context: HookContext,
    ) => Promise<void>;
    await handler({ type, data: {}, meta: { id: "end" } } as HookEvent<typeof type>, context);
    expect(record).toHaveBeenCalledWith("root", "child", "idle", "new", "end", 2);
    expect(remove).not.toHaveBeenCalled();
    expect(rootWork).not.toHaveBeenCalled();
  },
);

test("поколение регистрируется перед работой только на turn.started корня", async () => {
  const child = copyContext("root", "child");
  const rootContext = { ...child, session: { ...child.session, id: "root", parent: undefined } };
  const order: string[] = [];
  const register = vi.spyOn(waitGeneration, "registerSandboxWaitTurn").mockImplementation(async () => {
    order.push("register");
  });
  const rootWork = vi.spyOn(maintenance, "recordSandboxWork").mockImplementation(async () => {
    order.push("work");
  });
  vi.spyOn(copyWork, "recordSandboxCopyWork").mockImplementation(async () => {
    order.push("copy-work");
  });
  const capture = vi.spyOn(taskWaits, "captureSandboxCopyWait").mockImplementation(async () => {
    order.push("capture");
    return {} as Awaited<ReturnType<typeof taskWaits.captureSandboxCopyWait>>;
  });
  const started = {
    type: "turn.started", data: { turnId: "new", sequence: 2 }, meta: { id: "start" },
  } as HookEvent<"turn.started">;
  await sandboxQueueHook.events!["turn.started"]!(started, rootContext);
  expect(order).toEqual(["register", "work"]);
  expect(register).toHaveBeenCalledWith("root", "new");
  await sandboxQueueHook.events!["turn.started"]!(started, child);
  expect(capture).toHaveBeenCalledWith("root", "call", "new");
  expect(order).toEqual(["register", "work", "capture", "copy-work"]);
  expect(register).toHaveBeenCalledOnce();
  expect(rootWork).toHaveBeenCalledOnce();

  const step = {
    type: "step.started", data: { turnId: "new", sequence: 2 }, meta: { id: "step" },
  } as HookEvent<"step.started">;
  await sandboxQueueHook.events!["step.started"]!(step, rootContext);
  await sandboxQueueHook.events!["step.started"]!(step, child);
  expect(capture).toHaveBeenCalledOnce();
  expect(register).toHaveBeenCalledOnce();
  expect(rootWork).toHaveBeenCalledTimes(2);
});

test("ошибка регистрации поколения отменяет корень до записи работы", async () => {
  const child = copyContext("root", "child");
  const context = { ...child, session: { ...child.session, id: "root", parent: undefined } };
  vi.spyOn(waitGeneration, "registerSandboxWaitTurn").mockRejectedValue(new Error("unavailable"));
  const work = vi.spyOn(maintenance, "recordSandboxWork").mockResolvedValue(undefined);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  await sandboxQueueHook.events!["turn.started"]!({
    type: "turn.started", data: { turnId: "new", sequence: 2 }, meta: { id: "start" },
  } as HookEvent<"turn.started">, context);
  expect(context.cancel).toHaveBeenCalledOnce();
  expect(work).not.toHaveBeenCalled();
});

test("корневая граница освобождает очередь с поколением из события", async () => {
  const child = copyContext("root", "child");
  const context = { ...child, session: { ...child.session, id: "root", parent: undefined } };
  vi.spyOn(maintenance, "recordSandboxWork").mockResolvedValue(undefined);
  const remove = vi.spyOn(queueState, "removeSandboxQueueEntry").mockResolvedValue(undefined);
  await sandboxQueueHook.events!["turn.cancelled"]!({
    type: "turn.cancelled", data: { turnId: "old", sequence: 1 }, meta: { id: "end" },
  } as HookEvent<"turn.cancelled">, context);
  expect(remove).toHaveBeenCalledWith("root", undefined, "old");
  await sandboxQueueHook.events!["session.waiting"]!({
    type: "session.waiting", data: {}, meta: { id: "waiting" },
  } as HookEvent<"session.waiting">, context);
  expect(remove).toHaveBeenLastCalledWith("root", undefined, "new");
});

test("ошибка фиксации child generation отменяет копию до active и не повторяет capture на ответе", async () => {
  const context = copyContext("root", "child");
  const capture = vi.spyOn(taskWaits, "captureSandboxCopyWait").mockRejectedValue(new Error("unbound"));
  const record = vi.spyOn(copyWork, "recordSandboxCopyWork").mockResolvedValue(undefined);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  await sandboxQueueHook.events!["turn.started"]!({
    type: "turn.started", data: { turnId: "new", sequence: 2 }, meta: { id: "start" },
  } as HookEvent<"turn.started">, context);
  expect(record).not.toHaveBeenCalled();
  expect(context.cancel).toHaveBeenCalledOnce();
  await sandboxQueueHook.events!["input.resolved"]!({
    type: "input.resolved", data: { turnId: "new", sequence: 2 }, meta: { id: "answer" },
  } as HookEvent<"input.resolved">, context);
  expect(capture).toHaveBeenCalledOnce();
});

test.each(["task.started", "task.settled"] as const)("%s регистрируется только корнем", async (type) => {
  const child = copyContext("root", "child");
  const context = { ...child, session: { ...child.session, id: "root", parent: undefined } };
  const record = vi.spyOn(taskWaits, "recordSandboxTask").mockResolvedValue(undefined);
  const event = {
    type, data: { kind: "agent", taskId: "task", callId: "call", turnId: "root-turn" },
    meta: { id: "task-event" },
  } as HookEvent<typeof type>;
  const handler = sandboxQueueHook.events![type] as (event: HookEvent, ctx: HookContext) => Promise<void>;
  await handler(event, child);
  expect(record).not.toHaveBeenCalled();
  await handler(event, context);
  expect(record).toHaveBeenCalledWith(event.data, "root", type === "task.started" ? "active" : "settled");
  record.mockRejectedValueOnce(new Error("unavailable"));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  await handler(event, context);
  expect(context.cancel).not.toHaveBeenCalled();
});

test("allowWaitingTasks не освобождает выполняющийся шаг и по умолчанию выключен", () => {
  const event = (type: string, data = {}) => ({ payload: { type, data }, createdAt: new Date() });
  const events = [event("turn.started", { turnId: "root" }), event("turn.waiting", { turnId: "root", on: "tasks" })];
  expect(turnIsBusy(events)).toBe(true);
  expect(turnIsBusy(events, Date.now(), { allowWaitingTasks: true })).toBe(false);
  expect(turnIsBusy([...events, event("step.started", { turnId: "root" })], Date.now(), {
    allowWaitingTasks: true,
  })).toBe(true);
});

test.each([
  { other: "settled", busy: false },
  { other: "input", busy: false },
  { other: "active", busy: true },
  { other: "idle", busy: true },
  { other: "unbound", busy: true },
  { other: "no-worker", busy: true },
  { other: "tool", busy: true },
  { other: "step", busy: true },
  { other: "no-calls", busy: true },
] as const)("ожидание корнем tasks: input копии + $other → busy=$busy", async ({ other, busy }) => {
  const session = await root();
  const rootTurnId = "root-turn";
  await db().update(appSessions).set({
    sandboxWorkState: "active", sandboxWorkTurnId: rootTurnId, sandboxWorkEventId: "start",
  }).where(eq(appSessions.id, session.id));
  await db().insert(sessionEvents).values([
    { appSessionId: session.id, seq: 0, eventId: "start", payload: { type: "turn.started", data: { turnId: rootTurnId } } },
    { appSessionId: session.id, seq: 1, eventId: "wait", payload: { type: "turn.waiting", data: { turnId: rootTurnId, on: "tasks" } } },
  ]);
  async function task(taskId: string, state: "active" | "settled", workerState?: "input" | "active" | "idle", bind = true) {
    await db().insert(sandboxTaskCalls).values({
      appSessionId: session.id, taskId, callId: `call-${taskId}`, turnId: rootTurnId,
      generation: 0, kind: other === "tool" && taskId === "second" ? "tool" : "agent", state,
    });
    const eveSessionId = randomUUID();
    if (bind) await db().insert(agentSessions).values({
      appSessionId: session.id, taskId, callId: `call-${taskId}`, eveSessionId, name: "agent",
    });
    if (workerState) await recordSandboxCopyWork(session.eveSessionId, eveSessionId, workerState, taskId, taskId, 0);
  }
  if (other !== "no-calls") {
    await task("first", "active", "input");
    if (other === "settled") await task("second", "settled", "idle");
    else if (other === "unbound") await task("second", "active", undefined, false);
    else if (other === "no-worker") await task("second", "active");
    else if (other === "step") {
      await db().insert(sessionEvents).values({
        appSessionId: session.id, seq: 2, eventId: "step",
        payload: { type: "step.started", data: { turnId: rootTurnId } },
      });
    } else await task("second", "active", other === "tool" ? "input" : other);
  }
  const machine = { readJobDirectory: vi.fn(async () => emptyReading()) };
  expect(await sessionIsBusy(session.id, machine)).toBe(busy);
  const [saved] = await db().select().from(appSessions).where(eq(appSessions.id, session.id));
  expect(saved.sandboxWorkState).toBe(busy ? "active" : "idle");
});
