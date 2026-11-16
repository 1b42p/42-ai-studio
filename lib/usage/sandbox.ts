import { and, eq, sql, type SQL } from "drizzle-orm";
import type { PgUpdateSetSource } from "drizzle-orm/pg-core";
import type postgres from "postgres";

import { loadConfig } from "@/lib/config";
import { getDb, getSqlClient } from "@/lib/db/client";
import { cancellableQuery } from "@/lib/db/cancellable-query";
import { pendingSandboxUsage, sandboxes, usageRecords, type SandboxLaunch, type SandboxState } from "@/lib/db/schema";
import { sandboxIntervalEnd, sandboxTransition, type TransitionSource } from "./interval";

type Changes = Omit<PgUpdateSetSource<typeof sandboxes>, "id" | "state" | "runningSince">;
interface IntervalRow {
  id: string;
  app_session_id: string;
  state: SandboxState;
  running_since: string | Date | null;
  last_active_at: string | Date;
}

/** Drizzle строит SQL и параметры, postgres.js исполняет их в уже открытой транзакции. */
async function execute<T extends postgres.Row = postgres.Row>(
  tx: postgres.TransactionSql,
  query: { sql: string; params: unknown[] },
  signal?: AbortSignal,
) {
  return cancellableQuery(tx.unsafe<T[]>(query.sql, query.params as postgres.ParameterOrJSON<never>[]), signal);
}

interface Transition {
  sandboxId?: string;
  /** Дополнительный CAS-предикат существующего барьера запуска/обслуживания. */
  where?: SQL;
  newState: SandboxState;
  source: TransitionSource;
  observedAt?: Date;
  lastActivityAt?: Date | null;
  changes?: Changes;
  signal?: AbortSignal;
}

/**
 * Единственное место изменения состояния: строковый замок связывает интервал,
 * идемпотентную квитанцию и CAS-обновление состояния.
 */
export async function recordSandboxTransition(
  options: Transition,
  transaction?: postgres.TransactionSql,
): Promise<{ closedSeconds: number | null; updated: number }> {
  if (!options.sandboxId && !options.where) throw new Error("Sandbox identity required");
  const run = async (tx: postgres.TransactionSql) => {
    options.signal?.throwIfAborted();
    const rows = await execute<IntervalRow>(tx, getDb().select().from(sandboxes).where(and(
      options.sandboxId ? eq(sandboxes.id, options.sandboxId) : undefined,
      options.where,
    )).orderBy(sandboxes.id).for("update").toSQL(), options.signal);
    let closedSeconds: number | null = null;
    let updated = 0;
    for (const row of rows) {
      const observedAt = options.observedAt ?? new Date();
      const previousStart = row.running_since === null ? null : new Date(row.running_since);
      const action = sandboxTransition(row.state, options.newState, previousStart);
      let runningSince = previousStart;
      if (action === "open") runningSince = observedAt;
      if (action === "close" && previousStart) {
        const end = sandboxIntervalEnd({
          source: options.source, runningSince: previousStart, observedAt,
          lastActiveAt: new Date(row.last_active_at), lastActivityAt: options.lastActivityAt,
          idleMinutes: loadConfig().sandboxIdleStopMinutes,
        });
        const seconds = Math.round((end.getTime() - previousStart.getTime()) / 1000);
        try {
          // Savepoint позволяет сохранить квитанцию при отказе основной записи,
          // не отменяя уже выполненное действие провайдера.
          await tx.savepoint(async (savepoint) => {
            if (seconds <= 0) return;
            const [session] = await cancellableQuery(savepoint<{ user_id: string }[]>`
              select user_id from app_sessions where id = ${row.app_session_id}`, options.signal);
            if (!session) throw new Error("Usage owner missing");
            await execute(savepoint, getDb().insert(usageRecords).values({
              userId: session.user_id, appSessionId: row.app_session_id,
              kind: "sandbox_seconds", amount: seconds,
              sourceKey: `${row.id}:${previousStart.getTime()}`, recordedAt: end,
            }).onConflictDoNothing().toSQL(), options.signal);
          });
          runningSince = null;
          closedSeconds = (closedSeconds ?? 0) + Math.max(0, seconds);
        } catch {
          options.signal?.throwIfAborted();
          const [session] = await cancellableQuery(tx<{ user_id: string }[]>`
            select user_id from app_sessions where id = ${row.app_session_id}`, options.signal);
          if (!session) throw new Error("Usage owner missing");
          await execute(tx, getDb().insert(pendingSandboxUsage).values({
            userId: session.user_id, appSessionId: row.app_session_id,
            amount: seconds, sourceKey: `${row.id}:${previousStart.getTime()}`, recordedAt: end,
          }).onConflictDoNothing().toSQL(), options.signal);
          runningSince = null;
          closedSeconds = (closedSeconds ?? 0) + seconds;
          console.warn("[usage] sandbox_record_failed", "Не удалось сохранить интервал песочницы.");
        }
      }
      const saved = await execute(tx, getDb().update(sandboxes).set({
        ...options.changes, state: options.newState, runningSince,
      }).where(and(
        eq(sandboxes.id, row.id),
        options.where,
        previousStart ? eq(sandboxes.runningSince, previousStart) : sql`${sandboxes.runningSince} is null`,
      )).returning({ id: sandboxes.id }).toSQL(), options.signal);
      updated += saved.length;
    }
    return { closedSeconds, updated };
  };
  if (transaction) return run(transaction);
  let result!: Awaited<ReturnType<typeof run>>;
  await getSqlClient().begin(async (tx) => { result = await run(tx); });
  return result;
}

/** Отложенные квитанции сохраняют исходный конец, даже когда сессия уже удалена. */
export async function flushSandboxUsage(): Promise<void> {
  try {
    await getSqlClient().begin(async (tx) => {
      const pending = await tx<{ id: string }[]>`
        select id from pending_sandbox_usage order by id limit 100 for update skip locked`;
      if (!pending.length) return;
      const ids = pending.map((row) => row.id);
      await tx`
        insert into usage_records (user_id, app_session_id, kind, amount, source_key, recorded_at)
        select user_id, app_session_id, 'sandbox_seconds', amount, source_key, recorded_at
        from pending_sandbox_usage where id in ${tx(ids)}
        on conflict do nothing`;
      await tx`delete from pending_sandbox_usage where id in ${tx(ids)}`;
    });
  } catch {
    console.warn("[usage] sandbox_record_failed", "Не удалось сохранить интервал песочницы.");
  }
}

/** Резерв создаётся и меняет состояние под той же транзакцией выбора квоты. */
export async function reserveSandbox(
  transaction: postgres.TransactionSql,
  options: { appSessionId: string; keyId: string; launch: SandboxLaunch },
): Promise<void> {
  const [session] = await transaction<{ generation: number }[]>`
    select sandbox_wait_generation as generation from app_sessions where id = ${options.appSessionId}`;
  if (!session) return;
  await execute(transaction, getDb().insert(sandboxes).values({
    appSessionId: options.appSessionId, daytonaKeyId: options.keyId,
    daytonaSandboxId: "", state: "starting", startingSince: new Date(),
    startingKind: options.launch, waitGeneration: session.generation,
  }).onConflictDoNothing({ target: sandboxes.appSessionId }).toSQL());
  await recordSandboxTransition({
    where: eq(sandboxes.appSessionId, options.appSessionId),
    newState: "starting", source: "observed",
    changes: {
      daytonaKeyId: options.keyId,
      ...(options.launch === "create" ? { daytonaSandboxId: "" } : {}),
      startingSince: new Date(), startingKind: options.launch,
      lastActiveAt: new Date(), waitGeneration: session.generation, launchStartedAt: null,
    },
  }, transaction);
}
