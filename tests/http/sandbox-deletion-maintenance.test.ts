import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { expect, test } from "vitest";

import { dispatchSandboxQueue } from "../../agent/lib/sandbox-queue";
import { loadConfig } from "../../lib/config";
import { appSessions, queueEntries, sandboxes } from "../../lib/db/schema";
import { getFakeBackend } from "../../lib/sandbox/fake";
import { createDaytonaKey, createUser, db } from "./support/db";
import { fakeSandbox } from "./support/fake-sandbox";

test("очередь не архивирует машину с принятой maintenance-арендой удаления", async () => {
  const secret = "dtn_archive_maintenance_test";
  const key = await createDaytonaKey({ apiKey: secret });
  const resources = { cpu: 2, memoryGb: 4, diskGb: 8 };
  await fakeSandbox.setQuota(secret, resources);
  const owner = await createUser();
  const requester = await createUser();
  const [candidate] = await db().insert(appSessions).values({ userId: owner.id, eveSessionId: randomUUID() }).returning();
  const [waiting] = await db().insert(appSessions).values({ userId: requester.id, eveSessionId: randomUUID() }).returning();
  const backend = getFakeBackend(loadConfig().fakeSandboxDir!, secret, resources);
  const machine = await backend.create({ name: `archive-${candidate.id}`, appSessionId: candidate.id });
  await machine.stop();
  await db().insert(sandboxes).values({
    appSessionId: candidate.id, daytonaKeyId: key.id, daytonaSandboxId: machine.id,
    state: "stopped", stoppedAt: new Date(Date.now() - 60_000),
    maintenanceToken: randomUUID(), maintenanceUntil: new Date(Date.now() + 60_000),
  });
  await db().insert(queueEntries).values({ appSessionId: waiting.id, userId: requester.id, need: "create" });

  await dispatchSandboxQueue();
  expect((await fakeSandbox.counters()).archived).toBe(0);
  expect((await backend.get(machine.id)).state).toBe("stopped");

  await db().update(sandboxes).set({ maintenanceToken: null, maintenanceUntil: null })
    .where(eq(sandboxes.appSessionId, candidate.id));
  await expect.poll(async () => {
    await dispatchSandboxQueue();
    return (await fakeSandbox.counters()).archived;
  }, { timeout: 5000 }).toBe(1);
});
