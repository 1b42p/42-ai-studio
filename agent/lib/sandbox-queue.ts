import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { and, asc, eq, gt, isNull, lt } from "drizzle-orm";
import { SandboxSessionGoneError } from "eve/sandbox/provider";

import { loadConfig } from "@/lib/config";
import { getDb, getSqlClient } from "@/lib/db/client";
import {
  appSessions, daytonaKeys, queueEntries, sandboxDispatchers, sandboxes,
  type AppSession, type DaytonaKey, type QueueEntry, type Sandbox, type SandboxLaunch,
} from "@/lib/db/schema";
import { sessionIsBusy } from "@/lib/sandbox/busy";
import { errorStatus, isMissingSandbox, StudioSandboxError } from "@/lib/sandbox/errors";
import { DAYTONA_KEY_PURPOSE, decryptSecret } from "@/lib/secrets";
import { storedUsage } from "@/lib/daytona/usage";
import { daytonaBackend, type DaytonaMachine } from "./daytona-backend";
import { DELETED_KEY_MARKER, pickKey, refreshUsage } from "./daytona-key-pool";

const DISPATCHER_ID = "00000000-0000-4000-8000-000000000024";
const LIVE_MS = 60_000;
const RESERVATION_MS = 5 * 60_000;

function backend(key: DaytonaKey) {
  if (key.deletedAt !== null || key.apiKeyEncrypted === DELETED_KEY_MARKER) {
    throw new SandboxSessionGoneError("Ключ песочницы удалён.");
  }
  return daytonaBackend(key.id, decryptSecret(
    key.apiKeyEncrypted, loadConfig().secretsEncryptionKey, DAYTONA_KEY_PURPOSE,
  ));
}

function liveEntries() {
  return getDb().select().from(queueEntries)
    .where(gt(queueEntries.heartbeatAt, new Date(Date.now() - LIVE_MS)))
    .orderBy(asc(queueEntries.enqueuedAt), asc(queueEntries.id));
}

/** Список согласован с задержкой: отсутствие подтверждается отдельным get/404. */
export async function reconcileSandboxStates(): Promise<Map<string, DaytonaMachine>> {
  const db = getDb();
  const [entries, rows, keys] = await Promise.all([
    liveEntries(), db.select().from(sandboxes), db.select().from(daytonaKeys),
  ]);
  const keyIds = new Set([
    ...entries.flatMap((entry) => entry.daytonaKeyId ? [entry.daytonaKeyId] : []),
    ...rows.filter((row) => row.state !== "gone").map((row) => row.daytonaKeyId),
    ...keys.filter((key) => key.enabled && key.deletedAt === null).map((key) => key.id),
  ]);
  const machines = new Map<string, DaytonaMachine>();
  for (const key of keys.filter((key) => keyIds.has(key.id) && key.deletedAt === null &&
    storedUsage(key.usage)?.error !== "unauthorized")) {
    try {
      const client = backend(key);
      const listed = new Map<string, DaytonaMachine>();
      for await (const machine of client.list()) {
        if (machine.labels.studio_session) listed.set(machine.id, machine);
      }
      for (const row of rows.filter((row) => row.daytonaKeyId === key.id && row.state !== "gone")) {
        // Не затирать резерв ещё не начавшегося/не завершившегося запуска
        // устаревшим снимком Daytona.
        if (row.state === "starting" && row.startingSince &&
            Date.now() - row.startingSince.getTime() < RESERVATION_MS) continue;
        if (!row.daytonaSandboxId) continue;
        let machine = listed.get(row.daytonaSandboxId);
        if (!machine) {
          try { machine = await client.get(row.daytonaSandboxId); }
          catch (error) {
            if (!isMissingSandbox(error)) throw error;
            await db.update(sandboxes).set({ state: "gone" }).where(eq(sandboxes.id, row.id));
            continue;
          }
        }
        machines.set(row.appSessionId, machine);
        const state = machine.state;
        const mapped = state === "started" ? "started"
          : state === "stopped" || state === "stopping" ? "stopped"
          : state === "archived" || state === "archiving" ? "archived"
          : state === "destroyed" ? "gone" : "starting";
        await db.update(sandboxes).set({
          state: mapped,
          lastActiveAt: machine.lastActivityAt &&
            machine.lastActivityAt.getTime() > (row.daytonaActivityAt?.getTime() ?? row.createdAt.getTime()) &&
            machine.lastActivityAt > row.lastActiveAt
            ? machine.lastActivityAt : row.lastActiveAt,
          daytonaActivityAt: machine.lastActivityAt ?? row.daytonaActivityAt,
          stoppedAt: mapped === "stopped" ? row.stoppedAt ?? machine.stoppedAt ?? new Date() : null,
        }).where(and(eq(sandboxes.id, row.id), eq(sandboxes.state, row.state),
          eq(sandboxes.daytonaSandboxId, row.daytonaSandboxId)));
      }
      await refreshUsage(key.id, { force: true });
    } catch (error) {
      console.warn("[sandbox:queue] reconcile_failed", errorStatus(error) ?? "transport");
    }
  }
  return machines;
}

async function leaseDispatcher(): Promise<string | null> {
  const token = randomUUID();
  return getSqlClient().begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(20261110, 24)`;
    const rows = await tx`
      insert into sandbox_dispatchers (id, lease_token, lease_until)
      values (${DISPATCHER_ID}, ${token}, now() + interval '45 seconds')
      on conflict (id) do update set lease_token = excluded.lease_token, lease_until = excluded.lease_until
      where (sandbox_dispatchers.lease_until is null or sandbox_dispatchers.lease_until < now())
        and (sandbox_dispatchers.reconciled_at is null or sandbox_dispatchers.reconciled_at < now() - interval '1 second')
      returning id`;
    return rows.length ? token : null;
  });
}

async function activeRows() {
  return getDb().select({ sandbox: sandboxes, userId: appSessions.userId })
    .from(sandboxes).innerJoin(appSessions, eq(appSessions.id, sandboxes.appSessionId));
}

async function stopMachine(row: Sandbox, machine: DaytonaMachine): Promise<boolean> {
  // Повторно проверить события прямо перед остановкой, не только в начале прохода.
  if (await sessionIsBusy(row.appSessionId, machine)) return false;
  try {
    await machine.stop();
    if (machine.state !== "stopped") return false;
    await getDb().update(sandboxes).set({ state: "stopped", stoppedAt: new Date(),
      startingSince: null, startingKind: null })
      .where(and(eq(sandboxes.id, row.id), eq(sandboxes.daytonaSandboxId, machine.id)));
    return true;
  } catch (error) {
    console.warn("[sandbox:queue] stop_failed", errorStatus(error) ?? "transport");
    return false;
  }
}

function samePool(left: DaytonaKey, right: DaytonaKey): boolean {
  return left.id === right.id || (storedUsage(left.usage)?.organizationId != null &&
    storedUsage(left.usage)?.organizationId === storedUsage(right.usage)?.organizationId);
}

/** Освобождение диска допускается только когда vCPU и памяти уже достаточно. */
async function reclaim(entry: QueueEntry, machines: Map<string, DaytonaMachine>) {
  const db = getDb();
  const config = loadConfig();
  const rows = await activeRows();
  let changed = false;
  for (const { sandbox: row, userId } of rows) {
    if (userId === entry.userId || row.state !== "started" ||
        Date.now() - row.lastActiveAt.getTime() < config.sandboxIdleStopMinutes * 60_000) continue;
    const machine = machines.get(row.appSessionId);
    if (machine?.state === "started" && await stopMachine(row, machine)) changed = true;
  }
  if (changed) return;
  if (entry.need === "wake") return;
  const keys = await db.select().from(daytonaKeys).where(isNull(daytonaKeys.deletedAt));
  const candidates = keys.filter((key) => entry.daytonaKeyId
    ? key.id === entry.daytonaKeyId : key.enabled);
  for (const key of candidates) {
    const usage = storedUsage(key.usage);
    if (!usage?.cpu || !usage.memoryGb || !usage.diskGb ||
        usage.cpu.quota - usage.cpu.used < config.sandboxCpu ||
        usage.memoryGb.quota - usage.memoryGb.used < config.sandboxMemoryGb ||
        usage.diskGb.quota - usage.diskGb.used >= config.sandboxDiskGb) continue;
    const poolIds = new Set(keys.filter((other) => samePool(key, other)).map((other) => other.id));
    const stopped = rows.filter(({ sandbox: row, userId }) => row.state === "stopped" &&
      userId !== entry.userId && poolIds.has(row.daytonaKeyId))
      .sort((a, b) => (a.sandbox.stoppedAt ?? a.sandbox.lastActiveAt).getTime() -
        (b.sandbox.stoppedAt ?? b.sandbox.lastActiveAt).getTime());
    for (const { sandbox: row } of stopped) {
      const machine = machines.get(row.appSessionId);
      if (!machine || machine.state !== "stopped" || await sessionIsBusy(row.appSessionId, machine)) continue;
      try {
        await machine.archive();
        // Только подтверждённый archived означает освобождённый диск.
        if ((machine as DaytonaMachine).state === "archived") {
          await db.update(sandboxes).set({ state: "archived" }).where(eq(sandboxes.id, row.id));
        }
      } catch (error) {
        console.warn("[sandbox:queue] archive_failed", errorStatus(error) ?? "transport");
      }
      return;
    }
  }
}

/** Один проход; аренда координирует процессы, но не держит соединение на сети. */
export async function dispatchSandboxQueue(): Promise<void> {
  const db = getDb();
  await db.delete(queueEntries).where(lt(queueEntries.heartbeatAt, new Date(Date.now() - RESERVATION_MS)));
  if (!(await liveEntries()).length) return;
  const token = await leaseDispatcher();
  if (!token) return;
  const renew = setInterval(() => {
    void db.update(sandboxDispatchers).set({ leaseUntil: new Date(Date.now() + 45_000) })
      .where(and(eq(sandboxDispatchers.id, DISPATCHER_ID), eq(sandboxDispatchers.leaseToken, token)))
      .catch(() => {});
  }, 10_000);
  renew.unref();
  try {
    const machines = await reconcileSandboxStates();
    await db.update(sandboxDispatchers).set({ reconciledAt: new Date() })
      .where(eq(sandboxDispatchers.id, DISPATCHER_ID));
    for (const { sandbox: row } of await activeRows()) {
      const machine = machines.get(row.appSessionId);
      if (row.state === "started" && machine?.state === "started" && await sessionIsBusy(row.appSessionId, machine)) {
        try { await machine.refreshActivity(); }
        catch (error) { console.warn("[sandbox:queue] activity_failed", errorStatus(error) ?? "transport"); }
      }
    }
    for (const entry of await liveEntries()) {
      const ownsLease = await db.select({ id: sandboxDispatchers.id }).from(sandboxDispatchers)
        .where(and(eq(sandboxDispatchers.id, DISPATCHER_ID), eq(sandboxDispatchers.leaseToken, token),
          gt(sandboxDispatchers.leaseUntil, new Date())));
      if (!ownsLease.length) return;
      if (entry.need !== "create") {
        const [current] = await db.select().from(sandboxes)
          .where(eq(sandboxes.appSessionId, entry.appSessionId));
        const need = current?.state === "archived" ? "restore"
          : current?.state === "stopped" ? "wake" : entry.need;
        if (need !== entry.need) {
          entry.need = need;
          await db.update(queueEntries).set({ need }).where(eq(queueEntries.id, entry.id));
        }
      }
      const others = (await activeRows()).filter(({ sandbox: row, userId }) =>
        userId === entry.userId && row.appSessionId !== entry.appSessionId &&
        (row.state === "starting" || row.state === "started"));
      let ownBusy = false;
      for (const { sandbox: row } of others) {
        const machine = machines.get(row.appSessionId);
        if (!machine || row.state === "starting" || !await stopMachine(row, machine)) ownBusy = true;
      }
      await db.update(queueEntries).set({ reason: ownBusy ? "own_session_busy" : "capacity" })
        .where(eq(queueEntries.id, entry.id));
      if (ownBusy) continue;
      const config = loadConfig();
      const picked = await pickKey({ cpu: config.sandboxCpu, memoryGb: config.sandboxMemoryGb,
        diskGb: entry.need === "wake" ? 0 : config.sandboxDiskGb }, {
        appSessionId: entry.appSessionId, keyId: entry.daytonaKeyId ?? undefined,
        launch: entry.need, queueEntryId: entry.id,
      });
      if (picked.kind === "no_capacity") await reclaim(entry, machines);
    }
  } finally {
    clearInterval(renew);
    await db.update(sandboxDispatchers).set({ leaseUntil: null, leaseToken: null })
      .where(and(eq(sandboxDispatchers.id, DISPATCHER_ID), eq(sandboxDispatchers.leaseToken, token)));
  }
}

export async function awaitSlot(
  session: Pick<AppSession, "id" | "userId">,
  need: SandboxLaunch,
  keyId?: string,
  options: { maxWaitSeconds?: number } = {},
): Promise<DaytonaKey> {
  const config = loadConfig();
  const db = getDb();
  if (need === "create") {
    const keys = await db.select({ id: daytonaKeys.id }).from(daytonaKeys)
      .where(and(eq(daytonaKeys.enabled, true), isNull(daytonaKeys.deletedAt)));
    if (!keys.length) throw new StudioSandboxError("no_daytona_key");
  }
  const [entry] = await db.insert(queueEntries).values({
    appSessionId: session.id, userId: session.userId, need, daytonaKeyId: keyId,
  }).onConflictDoUpdate({ target: queueEntries.appSessionId, set: { heartbeatAt: new Date() } }).returning();
  const maxWaitMs = (options.maxWaitSeconds ?? config.sandboxQueueMaxWaitSeconds) * 1000;
  const deadline = Date.now() + maxWaitMs;
  try {
    while (true) {
      const [row] = await db.select().from(queueEntries).where(eq(queueEntries.id, entry.id));
      const [sandbox] = await db.select().from(sandboxes).where(eq(sandboxes.appSessionId, session.id));
      if (row === undefined) {
        if (sandbox?.slotRequestId === entry.id && sandbox.state !== "gone") {
          const [key] = await db.select().from(daytonaKeys).where(eq(daytonaKeys.id, sandbox.daytonaKeyId));
          if (!key || key.deletedAt !== null) throw new SandboxSessionGoneError("Ключ песочницы удалён.");
          return key;
        }
        throw new StudioSandboxError("sandbox_wait_cancelled");
      }
      if (Date.now() >= deadline || Date.now() - row.enqueuedAt.getTime() >= maxWaitMs) {
        throw new StudioSandboxError("sandbox_queue_timeout");
      }
      if (keyId) {
        const [key] = await db.select().from(daytonaKeys).where(eq(daytonaKeys.id, keyId));
        if (!key || key.deletedAt !== null) throw new SandboxSessionGoneError("Ключ песочницы удалён.");
      }
      await db.update(queueEntries).set({ heartbeatAt: new Date() }).where(eq(queueEntries.id, entry.id));
      // Проход может ждать Daytona, но отмена и heartbeat не ждут его завершения.
      void dispatchSandboxQueue().catch((error) => {
        console.warn("[sandbox:queue] dispatch_failed", errorStatus(error) ?? "internal");
      });
      await delay(config.sandboxQueuePollMs);
    }
  } finally {
    await db.delete(queueEntries).where(eq(queueEntries.id, entry.id));
  }
}
