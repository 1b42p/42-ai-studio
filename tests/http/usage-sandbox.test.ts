import { eq } from "drizzle-orm";
import { beforeEach, expect, test } from "vitest";

import { reconcileSandboxStates } from "../../agent/lib/sandbox-queue";
import { loadConfig } from "../../lib/config";
import { getSqlClient } from "../../lib/db/client";
import { appSessions, pendingSandboxUsage, sandboxes, usageRecords } from "../../lib/db/schema";
import { flushSandboxUsage, recordSandboxTransition } from "../../lib/usage/sandbox";
import { fetchApp } from "./support/app";
import { loginAs } from "./support/auth";
import { createSessionAs, sendAndWait } from "./support/chat";
import { createDaytonaKey, createUser, db, resetDatabase } from "./support/db";
import { fakeSandbox } from "./support/fake-sandbox";

beforeEach(async () => {
  await resetDatabase();
  await fakeSandbox.reset();
});

const READ = '/tool read_file {"filePath":"/workspace/usage.txt"}';

async function startedSession(user: Awaited<ReturnType<typeof createUser>>) {
  const session = await createSessionAs(user);
  await fakeSandbox.seed(session.id, { "/workspace/usage.txt": "данные" });
  await sendAndWait(user, session.id, READ);
  const [row] = await db().select().from(sandboxes).where(eq(sandboxes.appSessionId, session.id));
  expect(row.state).toBe("started");
  expect(row.runningSince).toBeInstanceOf(Date);
  return { session, row };
}

async function intervals(id: string) {
  return db().select().from(usageRecords).where(eq(usageRecords.kind, "sandbox_seconds"))
    .then((rows) => rows.filter((row) => row.appSessionId === id));
}

test("запуск второй сессии закрывает ровно один интервал первой", async () => {
  await createDaytonaKey();
  const user = await createUser();
  const { session: first, row } = await startedSession(user);
  // Управляем только началом интервала, а не временем работы HTTP-сервера.
  const start = new Date(Date.now() - 10_000);
  await db().update(sandboxes).set({ runningSince: start }).where(eq(sandboxes.id, row.id));
  const before = Date.now();
  await startedSession(user);
  const records = await intervals(first.id);
  expect(records).toHaveLength(1);
  expect(records[0].amount).toBeGreaterThanOrEqual(10);
  expect(records[0].amount).toBeLessThanOrEqual(Math.ceil((Date.now() - start.getTime()) / 1000) + 2);
  expect(records[0].recordedAt.getTime()).toBeGreaterThanOrEqual(before);
  expect((await db().select().from(sandboxes).where(eq(sandboxes.id, row.id)))[0].runningSince).toBeNull();
  await reconcileSandboxStates();
  expect(await intervals(first.id)).toHaveLength(1);
}, 60_000);

test("автостоп при resume записывается до нового интервала, с верхней границей наблюдения", async () => {
  await createDaytonaKey();
  const user = await createUser();
  const { session, row } = await startedSession(user);
  const start = new Date(Date.now() - 10_000);
  await db().update(sandboxes).set({ runningSince: start }).where(eq(sandboxes.id, row.id));
  await fakeSandbox.stop(session.id);
  await fakeSandbox.setTimes(session.id, { lastActivityAt: Date.now() });
  await sendAndWait(user, session.id, READ);
  const records = await intervals(session.id);
  expect(records).toHaveLength(1);
  expect(records[0].amount).toBeGreaterThanOrEqual(10);
  expect(records[0].amount).toBeLessThanOrEqual(Math.ceil((Date.now() - start.getTime()) / 1000));
  const [resumed] = await db().select().from(sandboxes).where(eq(sandboxes.id, row.id));
  expect(resumed.runningSince!.getTime()).toBeGreaterThan(start.getTime());
}, 60_000);

test("сверка относит запоздало замеченный автостоп ко дню окончания, а не наблюдения", async () => {
  await createDaytonaKey();
  const user = await createUser();
  const { session, row } = await startedSession(user);
  const start = new Date("2026-10-01T10:00:00Z");
  const activity = new Date("2026-10-01T10:05:00Z");
  await db().update(sandboxes).set({ runningSince: start, lastActiveAt: activity })
    .where(eq(sandboxes.id, row.id));
  await fakeSandbox.stop(session.id);
  await fakeSandbox.setTimes(session.id, { lastActivityAt: activity.getTime() });
  await reconcileSandboxStates();
  const [record] = await intervals(session.id);
  const expected = new Date(activity.getTime() + loadConfig().sandboxIdleStopMinutes * 60_000);
  expect(record.recordedAt).toEqual(expected);
  expect(record.amount).toBe((expected.getTime() - start.getTime()) / 1000);
  await reconcileSandboxStates();
  expect(await intervals(session.id)).toHaveLength(1);
}, 60_000);

test("параллельные закрытия и их повторы не удваивают расход", async () => {
  const user = await createUser();
  const key = await createDaytonaKey();
  const [session] = await db().insert(appSessions).values({ userId: user.id }).returning();
  const start = new Date("2026-10-01T10:00:00Z");
  const [row] = await db().insert(sandboxes).values({
    appSessionId: session.id, daytonaKeyId: key.id, daytonaSandboxId: "parallel",
    state: "started", runningSince: start,
  }).returning();
  const close = () => recordSandboxTransition({
    sandboxId: row.id, newState: "stopped", source: "app",
    observedAt: new Date("2026-10-01T10:01:00Z"),
  });
  const results = await Promise.all([close(), close()]);
  expect(results.map((result) => result.closedSeconds).sort()).toEqual([60, null].sort());
  expect((await intervals(session.id)).map((record) => record.amount)).toEqual([60]);
  await close();
  expect(await intervals(session.id)).toHaveLength(1);
});

test("дедлайн отменяет ожидание строкового замка без поздней записи состояния", async () => {
  const user = await createUser();
  const key = await createDaytonaKey();
  const [session] = await db().insert(appSessions).values({ userId: user.id }).returning();
  const [row] = await db().insert(sandboxes).values({
    appSessionId: session.id, daytonaKeyId: key.id, daytonaSandboxId: "deadline",
    state: "started", runningSince: new Date(Date.now() - 10_000),
  }).returning();
  let release!: () => void;
  let acquired!: () => void;
  const lockAcquired = new Promise<void>((resolve) => { acquired = resolve; });
  const lockRelease = new Promise<void>((resolve) => { release = resolve; });
  const holder = getSqlClient().begin(async (tx) => {
    await tx`select id from sandboxes where id = ${row.id} for update`;
    acquired();
    await lockRelease;
  });
  await lockAcquired;
  try {
    await expect(recordSandboxTransition({
      sandboxId: row.id, newState: "gone", source: "app", signal: AbortSignal.timeout(100),
    })).rejects.toThrow();
  } finally {
    release();
    await holder;
  }
  expect((await db().select().from(sandboxes).where(eq(sandboxes.id, row.id)))[0].state).toBe("started");
  expect(await intervals(session.id)).toHaveLength(0);
});

test("отложенный учёт сохраняет точные интервалы через новый запуск и удаление сессии", async () => {
  const user = await createUser();
  const key = await createDaytonaKey();
  const [session] = await db().insert(appSessions).values({ userId: user.id }).returning();
  const [row] = await db().insert(sandboxes).values({
    appSessionId: session.id, daytonaKeyId: key.id, daytonaSandboxId: "retry",
    state: "started", runningSince: new Date("2026-10-01T10:00:00Z"),
  }).returning();
  // Сбой на границе Postgres, не подмена внутренних функций учёта.
  await getSqlClient().begin(async (tx) => {
    await tx`alter table usage_records add constraint usage_test_reject check (kind <> 'sandbox_seconds')`;
    const result = await recordSandboxTransition({
      sandboxId: row.id, newState: "stopped", source: "app", observedAt: new Date("2026-10-01T10:01:00Z"),
    }, tx);
    expect(result.closedSeconds).toBe(60);
    const [stopped] = await tx`select state, running_since from sandboxes where id = ${row.id}`;
    expect(stopped.state).toBe("stopped");
    expect(stopped.running_since).toBeNull();
    await recordSandboxTransition({
      sandboxId: row.id, newState: "started", source: "app", observedAt: new Date("2026-10-01T12:00:00Z"),
    }, tx);
    await recordSandboxTransition({
      sandboxId: row.id, newState: "gone", source: "app", observedAt: new Date("2026-10-01T12:01:00Z"),
    }, tx);
    await tx`delete from app_sessions where id = ${session.id}`;
    await tx`alter table usage_records drop constraint usage_test_reject`;
  });
  const receipts = await db().select().from(pendingSandboxUsage);
  expect(receipts).toHaveLength(2);
  expect(receipts.every((receipt) => receipt.appSessionId === null)).toBe(true);
  await flushSandboxUsage();
  await flushSandboxUsage();
  const recorded = await db().select().from(usageRecords).where(eq(usageRecords.userId, user.id));
  expect(recorded.map((record) => record.amount)).toEqual([60, 60]);
  expect(recorded.map((record) => record.recordedAt.toISOString()).sort()).toEqual([
    "2026-10-01T10:01:00.000Z", "2026-10-01T12:01:00.000Z",
  ]);
  expect(await db().select().from(pendingSandboxUsage)).toHaveLength(0);
});

test("удаление запущенной сессии сохраняет расход с пустой ссылкой на сессию", async () => {
  await createDaytonaKey();
  const user = await createUser();
  const { session, row } = await startedSession(user);
  await db().update(sandboxes).set({ runningSince: new Date(Date.now() - 10_000) })
    .where(eq(sandboxes.id, row.id));
  const response = await fetchApp(`/api/sessions/${session.id}`, {
    method: "DELETE", headers: { cookie: await loginAs(user) },
  });
  expect(response.status).toBe(204);
  const records = await db().select().from(usageRecords).where(eq(usageRecords.userId, user.id));
  expect(records.some((record) => record.kind === "sandbox_seconds" && record.amount >= 10)).toBe(true);
  expect(records.every((record) => record.appSessionId === null)).toBe(true);
}, 60_000);
