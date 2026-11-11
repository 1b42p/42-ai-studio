import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeEach, expect, test } from "vitest";

import { pickKey } from "../../agent/lib/daytona-key-pool";
import { awaitSlot } from "../../agent/lib/sandbox-queue";
import { appSessions, queueEntries, sandboxes } from "../../lib/db/schema";
import { removeSandboxQueueEntry } from "../../lib/sandbox/queue-state";
import { assertSandboxWait, beginSandboxLaunch, captureSandboxWait } from "../../lib/sandbox/wait-generation";
import { createDaytonaKey, createUser, db, resetDatabase } from "./support/db";
import { fakeSandbox } from "./support/fake-sandbox";

beforeEach(async () => {
  await resetDatabase();
  await fakeSandbox.reset();
});

async function session() {
  const user = await createUser();
  const [row] = await db().insert(appSessions).values({ userId: user.id, eveSessionId: randomUUID() }).returning();
  return { ...row, eveSessionId: row.eveSessionId! };
}

test("старый ход не получает новое поколение после отмены и не отменяет следующий ход", async () => {
  const first = await session();
  const old = await captureSandboxWait(first, "old");
  await removeSandboxQueueEntry(first.eveSessionId, first.userId);
  await expect(assertSandboxWait(old)).rejects.toMatchObject({ code: "sandbox_wait_cancelled" });
  const [current] = await db().select().from(appSessions).where(eq(appSessions.id, first.id));
  await expect(captureSandboxWait(current, "old")).rejects.toMatchObject({ code: "sandbox_wait_cancelled" });
  const next = await captureSandboxWait(current, "next");
  await removeSandboxQueueEntry(first.eveSessionId, undefined, "old");
  await expect(assertSandboxWait(next)).resolves.toBeUndefined();
  await removeSandboxQueueEntry(first.eveSessionId, undefined, "next");
  await expect(assertSandboxWait(next)).rejects.toMatchObject({ code: "sandbox_wait_cancelled" });
  await removeSandboxQueueEntry(first.eveSessionId, undefined, "next");
  const [last] = await db().select().from(appSessions).where(eq(appSessions.id, first.id));
  expect(last.sandboxWaitGeneration).toBe(next.generation + 1);
});

test("cancel между чтением сессии и регистрацией хода не регистрирует новое ожидание", async () => {
  const row = await session();
  await removeSandboxQueueEntry(row.eveSessionId, row.userId);
  await expect(captureSandboxWait(row, "late")).rejects.toMatchObject({ code: "sandbox_wait_cancelled" });
});

test("запоздалый terminal без записи поколения не отменяет работу нового хода", async () => {
  const row = await session();
  const next = await captureSandboxWait(row, "next");
  await db().update(appSessions).set({ sandboxWorkTurnId: "next", sandboxWorkState: "active" })
    .where(eq(appSessions.id, row.id));
  await removeSandboxQueueEntry(row.eveSessionId, undefined, "unregistered-old");
  await expect(assertSandboxWait(next)).resolves.toBeUndefined();
});

test("отмена освобождает неиспользованный резерв и не даёт повторно получить место", async () => {
  await createDaytonaKey();
  const row = await session();
  const wait = await captureSandboxWait(row, "old");
  const [entry] = await db().insert(queueEntries).values({
    appSessionId: row.id, userId: row.userId, need: "create", waitGeneration: wait.generation,
  }).returning();
  expect(await pickKey({ cpu: 2, memoryGb: 4, diskGb: 8 }, {
    appSessionId: row.id, queueEntryId: entry.id,
  })).toMatchObject({ kind: "key" });
  await removeSandboxQueueEntry(row.eveSessionId, row.userId);
  const [reserved] = await db().select().from(sandboxes).where(eq(sandboxes.appSessionId, row.id));
  expect(reserved).toMatchObject({ state: "gone", startingSince: null, slotRequestId: null });
  await expect(beginSandboxLaunch(wait)).rejects.toMatchObject({ code: "sandbox_wait_cancelled" });
  await expect(awaitSlot(row, "create", undefined, { wait })).rejects.toMatchObject({ code: "sandbox_wait_cancelled" });
  expect(await db().select().from(queueEntries)).toHaveLength(0);
});

test("начатый запрос Daytona остаётся восстановимым после отмены", async () => {
  await createDaytonaKey();
  const row = await session();
  const wait = await captureSandboxWait(row, "old");
  const [entry] = await db().insert(queueEntries).values({
    appSessionId: row.id, userId: row.userId, need: "create", waitGeneration: wait.generation,
  }).returning();
  expect(await pickKey({ cpu: 2, memoryGb: 4, diskGb: 8 }, {
    appSessionId: row.id, queueEntryId: entry.id,
  })).toMatchObject({ kind: "key" });
  await beginSandboxLaunch(wait);
  await removeSandboxQueueEntry(row.eveSessionId, row.userId);
  const [reserved] = await db().select().from(sandboxes).where(eq(sandboxes.appSessionId, row.id));
  expect(reserved.state).toBe("starting");
  expect(reserved.launchStartedAt).not.toBeNull();
  await expect(assertSandboxWait(wait)).rejects.toMatchObject({ code: "sandbox_wait_cancelled" });
});
