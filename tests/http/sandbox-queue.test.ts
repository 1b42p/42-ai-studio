/** Очередь #24: настоящие HTTP-ходы eve, Postgres и файловый Daytona fake. */
import { setTimeout as delay } from "node:timers/promises";
import { and, eq, inArray } from "drizzle-orm";
import type { MessageStreamEvent } from "eve/client";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { awaitSlot, dispatchSandboxQueue } from "../../agent/lib/sandbox-queue";
import { loadConfig } from "../../lib/config";
import { getSqlClient } from "../../lib/db/client";
import { appSessions, daytonaKeys, queueEntries, sandboxes, type User } from "../../lib/db/schema";
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

const KEY = "dtn_queue_test_key";
const READ_FILE = '/tool read_file {"filePath":"/workspace/notes.txt"}';
const ONE_SLOT = { cpu: 2, memoryGb: 4, diskGb: 8 };
// Диск остановленных машин остаётся занят: для тестов CPU/памяти оставляем запас.
const ONE_RUNNING_SLOT = { ...ONE_SLOT, diskGb: 64 };

interface PendingTurn {
  events: Promise<MessageStreamEvent[]>;
  cancel(): Promise<void>;
  settled: boolean;
}

const pendingTurns: PendingTurn[] = [];

beforeEach(async () => {
  await resetDatabase();
  await fakeSandbox.reset();
});

afterEach(async () => {
  // Даже при проваленной проверке не оставлять ожидающий ход писать в следующую БД.
  await Promise.allSettled(pendingTurns.filter((turn) => !turn.settled).map((turn) => turn.cancel()));
  await Promise.allSettled(pendingTurns.map((turn) => turn.events));
  pendingTurns.length = 0;
});

async function status(user: User, id: string): Promise<SandboxStatus> {
  const response = await fetchApp(`/api/sessions/${id}/sandbox`, {
    headers: { cookie: await loginAs(user) },
  });
  expect(response.status).toBe(200);
  return response.json() as Promise<SandboxStatus>;
}

async function sandboxRow(id: string) {
  const [row] = await db().select().from(sandboxes).where(eq(sandboxes.appSessionId, id));
  expect(row, `Нет песочницы сессии ${id}`).toBeDefined();
  return row!;
}

function expectRead(events: readonly MessageStreamEvent[], text: string) {
  const results = events.filter((event) => event.type === "action.result" &&
    event.data.result.kind === "tool-result" && event.data.result.toolName === "read_file");
  expect(results).toHaveLength(1);
  expect(results[0].data).toMatchObject({
    status: "completed",
    result: { kind: "tool-result", toolName: "read_file", output: { content: expect.stringContaining(text) } },
  });
}

async function newSession(user: User, text: string) {
  const session = await createSessionAs(user);
  await fakeSandbox.seed(session.id, { "/workspace/notes.txt": text });
  return session;
}

async function startTurn(user: User, id: string, message = READ_FILE): Promise<PendingTurn> {
  const client = await eveClientAs(user, id);
  const cookie = await loginAs(user);
  const [session] = await db().select().from(appSessions).where(eq(appSessions.id, id));
  expect(session).toBeDefined();
  const response = session.eveSessionId === null
    ? (await client.sessions.create({ message })).response
    : await client.sessions.attach(session.eveSessionId).send(message);
  const turn: PendingTurn = {
    events: readStreamUntil(response, "session.waiting", { timeoutMs: 60_000 }),
    settled: false,
    async cancel() {
      const [bound] = await db().select().from(appSessions).where(eq(appSessions.id, id));
      if (!bound?.eveSessionId) return;
      const cancelled = await fetchApp(`/eve/v1/session/${bound.eveSessionId}/cancel`, {
        method: "POST", headers: { cookie },
      });
      expect(cancelled.ok).toBe(true);
    },
  };
  // Обработчик установлен сразу: ошибка потока не становится unhandled rejection.
  void turn.events.then(() => { turn.settled = true; }, () => { turn.settled = true; });
  pendingTurns.push(turn);
  return turn;
}

async function expectQueued(
  user: User,
  id: string,
  queue: NonNullable<SandboxStatus["queue"]>,
) {
  await expect.poll(() => status(user, id), { timeout: 10_000, interval: 100 }).toEqual({
    state: "queued", queue,
  });
}

async function expectQueueEmpty(id?: string) {
  await expect.poll(async () => {
    const query = db().select().from(queueEntries);
    return id ? query.where(eq(queueEntries.appSessionId, id)) : query;
  }, { timeout: 5000, interval: 50 }).toHaveLength(0);
}

describe("переключение сессий одного пользователя", () => {
  test("останавливает первую сразу и ни разу не держит две starting/started", async () => {
    await createDaytonaKey({ apiKey: KEY });
    await fakeSandbox.setQuota(KEY, { cpu: 4, memoryGb: 8, diskGb: 32 });
    const user = await createUser();
    const first = await newSession(user, "Первая сессия");
    const second = await newSession(user, "Вторая сессия");
    let sampling = true;
    const samples: number[] = [];
    const monitor = (async () => {
      while (sampling) {
        const active = await db().select({ id: sandboxes.id }).from(sandboxes)
          .innerJoin(appSessions, eq(appSessions.id, sandboxes.appSessionId))
          .where(and(eq(appSessions.userId, user.id), inArray(sandboxes.state, ["starting", "started"])));
        samples.push(active.length);
        await delay(50);
      }
    })();
    // Сохраняем ошибку чтения до finally, не теряя исходную проверку.
    void monitor.catch(() => {});
    try {
      expectRead(await sendAndWait(user, first.id, READ_FILE), "Первая сессия");
      expectRead(await sendAndWait(user, second.id, READ_FILE), "Вторая сессия");
      expect(await status(user, first.id)).toEqual({ state: "stopped", queue: null });
      expect(await status(user, second.id)).toEqual({ state: "started", queue: null });
      expect((await fakeSandbox.counters()).stopped).toBe(1);
    } finally {
      sampling = false;
      await monitor;
    }
    expect(samples.length).toBeGreaterThan(0);
    expect(samples.every((count) => count <= 1), JSON.stringify(samples)).toBe(true);
  }, 60_000);

  test("ждёт /slow 25, не вытесняет занятую и продлевает её нативную активность", async () => {
    await createDaytonaKey({ apiKey: KEY });
    await fakeSandbox.setQuota(KEY, { cpu: 4, memoryGb: 8, diskGb: 32 });
    const user = await createUser();
    const first = await newSession(user, "Занятая");
    const second = await newSession(user, "После завершения");
    expectRead(await sendAndWait(user, first.id, READ_FILE), "Занятая");
    const slow = await startTurn(user, first.id, "/slow 25 x");
    await waitForStoredEvents(user, first.id, (items) => {
      const latestStart = items.findLastIndex((item) => item.payload.type === "turn.started");
      return latestStart > 0 && items.slice(latestStart).some((item) => item.payload.type === "step.started") &&
        !items.slice(latestStart).some((item) => item.payload.type === "session.waiting");
    });
    const before = await fakeSandbox.counters();
    const waiting = await startTurn(user, second.id);
    await expectQueued(user, second.id, { position: 1, total: 1, reason: "own_session_busy" });
    expect(slow.settled).toBe(false);
    expect(await status(user, first.id)).toEqual({ state: "started", queue: null });
    expect((await fakeSandbox.counters()).stopped).toBe(before.stopped);
    await expect.poll(async () => (await fakeSandbox.counters()).refreshActivity, {
      timeout: 5000, interval: 100,
    }).toBeGreaterThan(before.refreshActivity);
    expect(JSON.stringify(await slow.events)).toContain("Эхо: x");
    expectRead(await waiting.events, "После завершения");
    expect(await status(user, first.id)).toEqual({ state: "stopped", queue: null });
    expect(await status(user, second.id)).toEqual({ state: "started", queue: null });
    await expectQueueEmpty();
  }, 60_000);

  test("новый ход ждёт уже принятую остановку перед работой с машиной", async () => {
    await createDaytonaKey({ apiKey: KEY });
    const user = await createUser();
    const session = await newSession(user, "Работа после остановки");
    expectRead(await sendAndWait(user, session.id, READ_FILE), "Работа после остановки");
    await db().update(sandboxes).set({
      maintenanceToken: "00000000-0000-4000-8000-000000000024",
      maintenanceUntil: new Date(Date.now() + 30_000),
    }).where(eq(sandboxes.appSessionId, session.id));
    const pending = await startTurn(user, session.id);
    try {
      await expect.poll(async () => {
        const [row] = await db().select().from(appSessions).where(eq(appSessions.id, session.id));
        return row.sandboxWorkState;
      }, { timeout: 5000 }).toBe("active");
      expect(pending.settled).toBe(false);
      await fakeSandbox.stop(session.id);
    } finally {
      await db().update(sandboxes).set({ maintenanceToken: null, maintenanceUntil: null })
        .where(eq(sandboxes.appSessionId, session.id));
    }
    expectRead(await pending.events, "Работа после остановки");
    expect((await sandboxRow(session.id)).state).toBe("started");
  }, 30_000);

  test("сбой барьера отменяет ход до инструмента; следующий ход после восстановления работает", async () => {
    await createDaytonaKey({ apiKey: KEY });
    const user = await createUser();
    const session = await newSession(user, "После восстановления базы");
    const sql = getSqlClient();
    await sql.unsafe(`create function studio_test_fail_sandbox_work() returns trigger language plpgsql as $$
      begin raise exception 'temporary work-state write failure' using errcode = '40001'; end $$`);
    try {
      await sql.unsafe(`create trigger studio_test_fail_sandbox_work before update of sandbox_work_state
        on app_sessions for each row when (NEW.sandbox_work_state = 'active')
        execute function studio_test_fail_sandbox_work()`);
      const events = await sendAndWait(user, session.id, READ_FILE);
      expect(events.some((event) => event.type === "turn.cancelled")).toBe(true);
      expect(events.filter((event) => event.type === "action.result")).toHaveLength(0);
      expect((await fakeSandbox.counters()).created).toBe(0);
    } finally {
      await sql.unsafe("drop trigger if exists studio_test_fail_sandbox_work on app_sessions");
      await sql.unsafe("drop function studio_test_fail_sandbox_work()");
    }
    expectRead(await sendAndWait(user, session.id, READ_FILE), "После восстановления базы");
  }, 30_000);
});

describe("ёмкость и FIFO", () => {
  test("C получает первый освободившийся слот, D следующий, без повторной отправки", async () => {
    await createDaytonaKey({ apiKey: KEY });
    await fakeSandbox.setQuota(KEY, { cpu: 4, memoryGb: 8, diskGb: 16 });
    const [a, b, c, d] = await Promise.all(Array.from({ length: 4 }, () => createUser()));
    const sa = await newSession(a, "A");
    const sb = await newSession(b, "B");
    const sc = await newSession(c, "C");
    const sd = await newSession(d, "D");
    expectRead(await sendAndWait(a, sa.id, READ_FILE), "A");
    expectRead(await sendAndWait(b, sb.id, READ_FILE), "B");
    const turnC = await startTurn(c, sc.id);
    await expectQueued(c, sc.id, { position: 1, total: 1, reason: "capacity" });
    const turnD = await startTurn(d, sd.id);
    await expectQueued(c, sc.id, { position: 1, total: 2, reason: "capacity" });
    await expectQueued(d, sd.id, { position: 2, total: 2, reason: "capacity" });
    expect((await fakeSandbox.counters()).stopped).toBe(0);

    const releasedA = Date.now();
    await fakeSandbox.stop(sa.id);
    await expect.poll(() => status(c, sc.id), { timeout: 10_000, interval: 100 })
      .toEqual({ state: "started", queue: null });
    expect(Date.now() - releasedA).toBeLessThan(10_000);
    expectRead(await turnC.events, "C");
    await expectQueued(d, sd.id, { position: 1, total: 1, reason: "capacity" });
    expect(turnD.settled).toBe(false);

    await fakeSandbox.stop(sb.id);
    await expect.poll(() => status(d, sd.id), { timeout: 10_000, interval: 100 })
      .toEqual({ state: "started", queue: null });
    expectRead(await turnD.events, "D");
    const created = await fakeSandbox.creationLog();
    expect(created.map((entry) => entry.appSessionId)).toEqual([sa.id, sb.id, sc.id, sd.id]);
    await expectQueueEmpty();
  }, 60_000);

  test("свежую чужую не трогает; после сдвига времени за порог останавливает сам", async () => {
    await createDaytonaKey({ apiKey: KEY });
    await fakeSandbox.setQuota(KEY, ONE_RUNNING_SLOT);
    const owner = await createUser();
    const newcomer = await createUser();
    const first = await newSession(owner, "Недавно работала");
    const second = await newSession(newcomer, "Получила место");
    expectRead(await sendAndWait(owner, first.id, READ_FILE), "Недавно работала");
    const waiting = await startTurn(newcomer, second.id);
    await expectQueued(newcomer, second.id, { position: 1, total: 1, reason: "capacity" });
    expect((await fakeSandbox.counters()).stopped).toBe(0);
    expect((await sandboxRow(first.id)).state).toBe("started");

    const old = Date.now() - (loadConfig().sandboxIdleStopMinutes + 1) * 60_000;
    // Согласуем часы fake и SQL: reconcile берёт более свежую активность Daytona.
    await fakeSandbox.setTimes(first.id, { lastActivityAt: old });
    await db().update(sandboxes).set({ lastActiveAt: new Date(old) })
      .where(eq(sandboxes.appSessionId, first.id));
    await expect.poll(() => status(newcomer, second.id), { timeout: 10_000, interval: 100 })
      .toEqual({ state: "started", queue: null });
    expectRead(await waiting.events, "Получила место");
    expect((await fakeSandbox.counters()).stopped).toBe(1);
    expect(await status(owner, first.id)).toEqual({ state: "stopped", queue: null });
  }, 60_000);

  test("освобождает диск архивацией и восстанавливает прежнюю машину вместе с файлами", async () => {
    await createDaytonaKey({ apiKey: KEY });
    await fakeSandbox.setQuota(KEY, ONE_SLOT);
    const a = await createUser();
    const b = await createUser();
    const sa = await newSession(a, "Сохранённый файл A");
    const sb = await newSession(b, "Сохранённый файл B");
    expectRead(await sendAndWait(a, sa.id, READ_FILE), "Сохранённый файл A");
    const original = await sandboxRow(sa.id);
    await fakeSandbox.stop(sa.id);
    expectRead(await sendAndWait(b, sb.id, READ_FILE), "Сохранённый файл B");
    expect((await fakeSandbox.counters()).archived).toBe(1);
    expect(await status(a, sa.id)).toEqual({ state: "archived", queue: null });

    const restoring = await startTurn(a, sa.id);
    await expectQueued(a, sa.id, { position: 1, total: 1, reason: "capacity" });
    const [entry] = await db().select().from(queueEntries).where(eq(queueEntries.appSessionId, sa.id));
    expect(entry).toMatchObject({ need: "restore", daytonaKeyId: original.daytonaKeyId });
    await fakeSandbox.stop(sb.id);
    expectRead(await restoring.events, "Сохранённый файл A");
    expect(await sandboxRow(sa.id)).toMatchObject({
      daytonaSandboxId: original.daytonaSandboxId, state: "started",
    });
    expect(await status(b, sb.id)).toEqual({ state: "archived", queue: null });
    const retained = await fakeSandbox.files.read(sb.id, "/workspace/notes.txt");
    expect(retained).not.toBeNull();
    expect(Buffer.from(retained!).toString("utf8")).toBe("Сохранённый файл B");
    expect(await fakeSandbox.counters()).toMatchObject({ created: 2, archived: 2, restored: 1 });
    await expectQueueEmpty();
  }, 60_000);

  test("отказ Daytona по квоте при пробуждении возвращает в очередь, не теряя файлов", async () => {
    const key = await createDaytonaKey({ apiKey: KEY });
    const user = await createUser();
    const session = await newSession(user, "После временного отказа квоты");
    expectRead(await sendAndWait(user, session.id, READ_FILE), "После временного отказа квоты");
    await fakeSandbox.stop(session.id);
    await fakeSandbox.failNextStartForQuota();
    const pending = await startTurn(user, session.id);
    await expect.poll(async () => {
      const [row] = await db().select().from(daytonaKeys).where(eq(daytonaKeys.id, key.id));
      return row.exhaustedUntil;
    }, { timeout: 5000, interval: 50 }).not.toBeNull();
    await expectQueued(user, session.id, { position: 1, total: 1, reason: "capacity" });
    expect(pending.settled).toBe(false);
    await db().update(daytonaKeys).set({ exhaustedUntil: null }).where(eq(daytonaKeys.id, key.id));
    expectRead(await pending.events, "После временного отказа квоты");
    expect((await fakeSandbox.counters()).created).toBe(1);
  }, 30_000);
});

describe("отмена, таймаут и уборка заявок", () => {
  test("HTTP cancel снимает ожидание; следующий ход той же сессии работает", async () => {
    await createDaytonaKey({ apiKey: KEY });
    await fakeSandbox.setQuota(KEY, ONE_RUNNING_SLOT);
    const a = await createUser();
    const b = await createUser();
    const first = await newSession(a, "Занимает слот");
    const second = await newSession(b, "Следующий ход");
    expectRead(await sendAndWait(a, first.id, READ_FILE), "Занимает слот");
    const waiting = await startTurn(b, second.id);
    await expectQueued(b, second.id, { position: 1, total: 1, reason: "capacity" });
    const cancelledAt = Date.now();
    await waiting.cancel();
    await expectQueueEmpty(second.id);
    expect(Date.now() - cancelledAt).toBeLessThan(5000);
    expect((await waiting.events).some((event) => event.type === "turn.cancelled")).toBe(true);
    // Повторные проходы не должны воскрешать удалённую заявку.
    await dispatchSandboxQueue();
    await dispatchSandboxQueue();
    await expectQueueEmpty(second.id);
    expect((await fakeSandbox.counters()).created).toBe(1);

    await fakeSandbox.stop(first.id);
    expectRead(await sendAndWait(b, second.id, READ_FILE), "Следующий ход");
    expect((await fakeSandbox.counters()).created).toBe(2);
    await expectQueueEmpty();
  }, 60_000);

  test("awaitSlot завершается через пять секунд и не создаёт заявку заново", async () => {
    await createDaytonaKey({ apiKey: KEY });
    await fakeSandbox.setQuota(KEY, ONE_RUNNING_SLOT);
    const a = await createUser();
    const b = await createUser();
    const occupied = await newSession(a, "Занимает слот");
    expectRead(await sendAndWait(a, occupied.id, READ_FILE), "Занимает слот");
    const queued = await createSessionAs(b);
    const startedAt = Date.now();
    const outcome = awaitSlot({ id: queued.id, userId: b.id }, "create", undefined, { maxWaitSeconds: 5 })
      .then((key) => ({ key, error: null }), (error: unknown) => ({ key: null, error }));
    await expectQueued(b, queued.id, { position: 1, total: 1, reason: "capacity" });
    const { error } = await outcome;
    expect(error).toMatchObject({ code: "sandbox_queue_timeout" });
    expect(String(error)).toContain("Свободная песочница так и не появилась");
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(5000);
    expect(Date.now() - startedAt).toBeLessThan(10_000);
    await expectQueueEmpty(queued.id);
    await fakeSandbox.stop(occupied.id);
    await dispatchSandboxQueue();
    await dispatchSandboxQueue();
    await expectQueueEmpty();
    expect((await fakeSandbox.counters()).created).toBe(1);
    expect(await db().select().from(sandboxes).where(eq(sandboxes.appSessionId, queued.id))).toHaveLength(0);
  }, 30_000);

  test("снятая заявка завершает awaitSlot с sandbox_wait_cancelled без повторной вставки", async () => {
    await createDaytonaKey({ apiKey: KEY });
    await fakeSandbox.setQuota(KEY, ONE_RUNNING_SLOT);
    const a = await createUser();
    const b = await createUser();
    const occupied = await newSession(a, "Занимает слот");
    expectRead(await sendAndWait(a, occupied.id, READ_FILE), "Занимает слот");
    const queued = await createSessionAs(b);
    const outcome = awaitSlot({ id: queued.id, userId: b.id }, "create", undefined, { maxWaitSeconds: 5 })
      .then(() => null, (error: unknown) => error);
    await expectQueued(b, queued.id, { position: 1, total: 1, reason: "capacity" });
    await db().delete(queueEntries).where(eq(queueEntries.appSessionId, queued.id));
    expect(await outcome).toMatchObject({ code: "sandbox_wait_cancelled" });
    await dispatchSandboxQueue();
    await expectQueueEmpty();
    expect((await fakeSandbox.counters()).created).toBe(1);
  }, 30_000);

  test("таймаут провайдера даёт ровно один failed action.result и не воскрешает очередь", async () => {
    await createDaytonaKey({ apiKey: KEY });
    await fakeSandbox.setQuota(KEY, ONE_RUNNING_SLOT);
    const a = await createUser();
    const b = await createUser();
    const occupied = await newSession(a, "Занимает слот");
    expectRead(await sendAndWait(a, occupied.id, READ_FILE), "Занимает слот");
      const queued = await newSession(b, "Ожидание истекло");
      const turn = await startTurn(b, queued.id);
      await expectQueued(b, queued.id, { position: 1, total: 1, reason: "capacity" });
      await db().update(queueEntries).set({ enqueuedAt: new Date(Date.now() -
        (loadConfig().sandboxQueueMaxWaitSeconds + 1) * 1000) })
        .where(eq(queueEntries.appSessionId, queued.id));
      const events = await turn.events;
      const results = events.filter((event) => event.type === "action.result");
      expect(results).toHaveLength(1);
      expect(results[0].data).toMatchObject({ status: "failed" });
      expect(JSON.stringify(results[0])).toContain("sandbox_queue_timeout:");
      await expectQueueEmpty();
      await dispatchSandboxQueue();
      await expectQueueEmpty();
      expect((await fakeSandbox.counters()).created).toBe(1);
  }, 30_000);

  test("старше минуты не учитываются в позиции; старше пяти минут удаляются", async () => {
    await createDaytonaKey({ apiKey: KEY });
    await fakeSandbox.setQuota(KEY, ONE_RUNNING_SLOT);
    const owner = await createUser();
    const occupied = await newSession(owner, "Занимает слот");
    expectRead(await sendAndWait(owner, occupied.id, READ_FILE), "Занимает слот");
    const b = await createUser();
    const live = await newSession(b, "Живая заявка");
    const stale = await createSessionAs(await createUser());
    const dead = await createSessionAs(await createUser());
    const sessions = await db().select().from(appSessions).where(inArray(appSessions.id, [stale.id, dead.id]));
    for (const session of sessions) {
      await db().insert(queueEntries).values({
        appSessionId: session.id, userId: session.userId, need: "create",
        enqueuedAt: new Date(Date.now() - 10 * 60_000),
        heartbeatAt: new Date(Date.now() - (session.id === dead.id ? 301_000 : 61_000)),
      });
    }
    const waiting = await startTurn(b, live.id);
    await expectQueued(b, live.id, { position: 1, total: 1, reason: "capacity" });
    await expect.poll(async () => db().select().from(queueEntries)
      .where(eq(queueEntries.appSessionId, dead.id)), { timeout: 5000, interval: 50 }).toHaveLength(0);
    expect(await db().select().from(queueEntries).where(eq(queueEntries.appSessionId, stale.id)))
      .toHaveLength(1);
    expect((await fakeSandbox.counters()).created).toBe(1);
    await waiting.cancel();
    await waiting.events;
    await expectQueueEmpty(live.id);
  }, 30_000);
});

test("создание и пробуждение выставляют настройки нативного жизненного цикла", async () => {
  await createDaytonaKey({ apiKey: KEY });
  const user = await createUser();
  const session = await newSession(user, "Переживает остановку");
  expectRead(await sendAndWait(user, session.id, READ_FILE), "Переживает остановку");
  const config = loadConfig();
  const intervals = {
    autoStopInterval: config.sandboxIdleStopMinutes,
    autoArchiveInterval: config.sandboxArchiveAfterDays * 1440,
  };
  const [created] = await fakeSandbox.creationLog(session.id);
  expect(created).toMatchObject({ ...intervals, autoDeleteInterval: -1 });
  const original = await sandboxRow(session.id);
  const before = await fakeSandbox.lifecycleLog(session.id);
  await fakeSandbox.stop(session.id);
  expectRead(await sendAndWait(user, session.id, READ_FILE), "Переживает остановку");
  const after = await fakeSandbox.lifecycleLog(session.id);
  expect(after.length).toBeGreaterThan(before.length);
  expect(after.slice(before.length)).toEqual(expect.arrayContaining([
    expect.objectContaining({ ...intervals, id: original.daytonaSandboxId, appSessionId: session.id }),
  ]));
  expect((await sandboxRow(session.id)).daytonaSandboxId).toBe(original.daytonaSandboxId);
  expect((await fakeSandbox.counters()).created).toBe(1);
}, 60_000);
