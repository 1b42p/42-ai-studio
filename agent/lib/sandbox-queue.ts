import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { and, asc, eq, gt, isNull, lt, sql } from "drizzle-orm";
import { SandboxSessionGoneError } from "eve/sandbox/provider";

import { loadConfig } from "@/lib/config";
import { getDb, getSqlClient } from "@/lib/db/client";
import {
  appSessions, daytonaKeys, queueEntries, sandboxDispatchers, sandboxes,
  type AppSession, type DaytonaKey, type QueueEntry, type Sandbox, type SandboxLaunch,
} from "@/lib/db/schema";
import { sessionIsBusy } from "@/lib/sandbox/busy";
import { assertSandboxWait, type SandboxWait } from "@/lib/sandbox/wait-generation";
import { sandboxState } from "@/lib/sandbox/daytona-state";
import { errorStatus, isMissingSandbox, StudioSandboxError } from "@/lib/sandbox/errors";
import { DAYTONA_KEY_PURPOSE, decryptSecret } from "@/lib/secrets";
import { storedUsage } from "@/lib/daytona/usage";
import { daytonaBackend, daytonaSandboxName, type DaytonaMachine } from "./daytona-backend";
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
    liveEntries(), db.select({ sandbox: sandboxes, eveSessionId: appSessions.eveSessionId })
      .from(sandboxes).innerJoin(appSessions, eq(appSessions.id, sandboxes.appSessionId)),
    db.select().from(daytonaKeys),
  ]);
  const keyIds = new Set([
    ...entries.flatMap((entry) => entry.daytonaKeyId ? [entry.daytonaKeyId] : []),
    ...rows.filter(({ sandbox }) => sandbox.state !== "gone").map(({ sandbox }) => sandbox.daytonaKeyId),
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
      for (const { sandbox: row, eveSessionId } of rows.filter(({ sandbox }) =>
        sandbox.daytonaKeyId === key.id && sandbox.state !== "gone")) {
        // Не затирать резерв ещё не начавшегося/не завершившегося запуска
        // устаревшим снимком Daytona.
        if (row.state === "starting" && row.startingSince &&
            Date.now() - row.startingSince.getTime() < RESERVATION_MS) continue;
        // До привязки первого вложения имя из appSessionId восстановить нельзя.
        if (!row.daytonaSandboxId && !eveSessionId) continue;
        const unchanged = and(
          eq(sandboxes.id, row.id), eq(sandboxes.state, row.state),
          eq(sandboxes.daytonaKeyId, row.daytonaKeyId),
          eq(sandboxes.daytonaSandboxId, row.daytonaSandboxId),
          row.startingSince === null ? isNull(sandboxes.startingSince)
            : eq(sandboxes.startingSince, row.startingSince),
          row.startingKind === null ? isNull(sandboxes.startingKind)
            : eq(sandboxes.startingKind, row.startingKind),
          row.slotRequestId === null ? isNull(sandboxes.slotRequestId)
            : eq(sandboxes.slotRequestId, row.slotRequestId),
          row.maintenanceToken === null ? isNull(sandboxes.maintenanceToken)
            : eq(sandboxes.maintenanceToken, row.maintenanceToken),
        );
        try {
          const idOrName = row.daytonaSandboxId ||
            daytonaSandboxName(eveSessionId!);
          let machine = listed.get(row.daytonaSandboxId);
          // list служит снимком, а не подтверждением смены состояния (в том
          // числе stopped после уже завершённого пробуждения).
          if (!machine || machine.state !== row.state) {
            try { machine = await client.get(idOrName); }
            catch (error) {
              if (!isMissingSandbox(error)) throw error;
              await db.update(sandboxes).set({ state: "gone", startingSince: null, startingKind: null })
                .where(unchanged);
              continue;
            }
          }
          // Ошибку машины нельзя выдавать за новый запуск или утрату.
          // Идентификатор незаписанного создания всё равно сохраняем.
          let mapped = row.state;
          try { mapped = sandboxState(machine.state); }
          catch (error) {
            if (!(error instanceof StudioSandboxError)) throw error;
          }
          const activity = machine.lastActivityAt;
          const [updated] = await db.update(sandboxes).set({
            daytonaSandboxId: machine.id,
            state: mapped,
            startingSince: mapped === "starting" ? row.startingSince : null,
            startingKind: mapped === "starting" ? row.startingKind : null,
            lastActiveAt: activity &&
              activity.getTime() > (row.daytonaActivityAt?.getTime() ?? row.createdAt.getTime())
              ? sql`greatest(${sandboxes.lastActiveAt}, ${activity.toISOString()}::timestamptz)`
              : sql`${sandboxes.lastActiveAt}`,
            daytonaActivityAt: activity
              ? sql`greatest(${sandboxes.daytonaActivityAt}, ${activity.toISOString()}::timestamptz)`
              : sql`${sandboxes.daytonaActivityAt}`,
            stoppedAt: machine.state === "stopped"
              ? (row.state === "stopped" ? row.stoppedAt : null) ?? machine.stoppedAt ?? new Date()
              : null,
          }).where(unchanged).returning({ id: sandboxes.id });
          // Устаревший handle не должен попасть в последующую остановку/архивацию.
          if (updated) machines.set(row.appSessionId, machine);
        } catch (error) {
          console.warn("[sandbox:queue] reconcile_failed", errorStatus(error) ?? "transport");
        }
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
  const token = randomUUID();
  const claimed = await getSqlClient().begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(20261111, hashtext(${row.appSessionId}))`;
    return tx`update sandboxes set maintenance_token = ${token},
      maintenance_until = now() + interval '330 seconds'
      where id = ${row.id} and state = 'started' and daytona_sandbox_id = ${machine.id}
      and (maintenance_until is null or maintenance_until < now())
      and exists (select 1 from app_sessions where id = ${row.appSessionId}
        and sandbox_work_state <> 'active')
      and not exists (select 1 from sandbox_workers where app_session_id = ${row.appSessionId}
        and state = 'active') returning id`;
  });
  if (!claimed.length) return false;
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
  } finally {
    await getDb().update(sandboxes).set({ maintenanceToken: null, maintenanceUntil: null })
      .where(and(eq(sandboxes.id, row.id), eq(sandboxes.maintenanceToken, token)));
  }
}

function samePool(left: DaytonaKey, right: DaytonaKey): boolean {
  return left.id === right.id || (storedUsage(left.usage)?.organizationId != null &&
    storedUsage(left.usage)?.organizationId === storedUsage(right.usage)?.organizationId);
}

/** Освобождение диска допускается только когда vCPU и памяти уже достаточно. */
async function reclaim(entry: QueueEntry, machines: Map<string, DaytonaMachine>): Promise<boolean> {
  const db = getDb();
  const config = loadConfig();
  const rows = await activeRows();
  const keys = await db.select().from(daytonaKeys).where(isNull(daytonaKeys.deletedAt));
  const candidates = keys.filter((key) => entry.daytonaKeyId
    ? key.id === entry.daytonaKeyId : key.enabled);
  for (const key of candidates) {
    const usage = storedUsage(key.usage);
    if (!usage?.cpu || !usage.memoryGb || !usage.diskGb || usage.error === "unauthorized") continue;
    const poolIds = new Set(keys.filter((other) => samePool(key, other)).map((other) => other.id));
    const reserved = rows.filter(({ sandbox: row }) => poolIds.has(row.daytonaKeyId) &&
      row.appSessionId !== entry.appSessionId && row.state === "starting" && row.startingSince &&
      Date.now() - row.startingSince.getTime() < RESERVATION_MS);
    const lacksCompute = usage.cpu.quota - usage.cpu.used - reserved.length * config.sandboxCpu < config.sandboxCpu ||
      usage.memoryGb.quota - usage.memoryGb.used - reserved.length * config.sandboxMemoryGb < config.sandboxMemoryGb;
    if (lacksCompute) {
      for (const { sandbox: row, userId } of rows) {
        if (!poolIds.has(row.daytonaKeyId) || userId === entry.userId || row.state !== "started" ||
            Date.now() - row.lastActiveAt.getTime() < config.sandboxIdleStopMinutes * 60_000) continue;
        const machine = machines.get(row.appSessionId);
        if (machine?.state === "started" && await stopMachine(row, machine)) return true;
      }
      continue;
    }
    const diskReserved = reserved.filter(({ sandbox }) => sandbox.startingKind !== "wake").length * config.sandboxDiskGb;
    if (entry.need === "wake" ||
        usage.diskGb.quota - usage.diskGb.used - diskReserved >= config.sandboxDiskGb) continue;
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
        return true;
      } catch (error) {
        console.warn("[sandbox:queue] archive_failed", errorStatus(error) ?? "transport");
      }
      return false;
    }
  }
  return false;
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
      if (picked.kind === "no_capacity" && await reclaim(entry, machines)) return;
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
  options: { maxWaitSeconds?: number; wait?: SandboxWait } = {},
): Promise<DaytonaKey> {
  const config = loadConfig();
  const db = getDb();
  if (need === "create") {
    const keys = await db.select({ id: daytonaKeys.id }).from(daytonaKeys)
      .where(and(eq(daytonaKeys.enabled, true), isNull(daytonaKeys.deletedAt)));
    if (!keys.length) throw new StudioSandboxError("no_daytona_key");
  }
  const entry = await getSqlClient().begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(20261110, 24)`;
    const [current] = await tx<{ generation: number }[]>`
      select sandbox_wait_generation as generation from app_sessions where id = ${session.id}
        and user_id = ${session.userId}`;
    if (!current || (options.wait && current.generation !== options.wait.generation)) {
      throw new StudioSandboxError("sandbox_wait_cancelled");
    }
    const [row] = await tx<{ id: string }[]>`
      insert into queue_entries (app_session_id, user_id, need, daytona_key_id, wait_generation)
      values (${session.id}, ${session.userId}, ${need}, ${keyId ?? null}, ${current.generation})
      on conflict (app_session_id) do update set heartbeat_at = now()
      where queue_entries.wait_generation = excluded.wait_generation returning id`;
    if (!row) throw new StudioSandboxError("sandbox_wait_cancelled");
    return { id: row.id, waitGeneration: current.generation };
  });
  const wait = options.wait ?? { appSessionId: session.id, generation: entry.waitGeneration };
  const maxWaitMs = (options.maxWaitSeconds ?? config.sandboxQueueMaxWaitSeconds) * 1000;
  const deadline = Date.now() + maxWaitMs;
  try {
    while (true) {
      await assertSandboxWait(wait);
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
