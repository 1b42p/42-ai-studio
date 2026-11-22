import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import postgres from "postgres";
import { Client } from "eve/client";

import { deleteDaytonaMachine, daytonaSandboxName } from "@/agent/lib/daytona-backend";
import { DELETED_KEY_MARKER } from "@/agent/lib/daytona-key-pool";
import { signInternalToken } from "@/lib/auth/internal-tokens";
import { loadConfig } from "@/lib/config";
import { getStorage } from "@/lib/s3";
import { DAYTONA_KEY_PURPOSE, decryptSecret } from "@/lib/secrets";
import { errorStatus, isMissingSandbox } from "@/lib/sandbox/errors";
import { recordSandboxTransition } from "@/lib/usage/sandbox";
import { cancellableQuery as query } from "@/lib/db/cancellable-query";
import { enqueueLateUploadCleanup } from "./late-upload-cleanup";
import { deleteHistoricalDaytonaMachines } from "./daytona-erasure";

export interface SessionDeletionResult {
  status: "deleted" | "not_found" | "conflict" | "upstream_error";
  message?: string;
  /** Удаление остановлено внешним дедлайном; вызывающий решает, повторять ли. */
  timedOut?: boolean;
  /** Длительности завершённых шагов; ключи подходят для ручных замеров. */
  timings: Partial<Record<"mark" | "eve" | "daytona" | "s3" | "database" | "s3Final", number>>;
}

export interface SessionDeletionOptions {
  /** Общий дедлайн операции; по умолчанию 120 секунд от вызова. */
  readonly deadline?: number;
  /** Внешний сигнал отмены, например бюджет пачки удаления пользователя. */
  readonly signal?: AbortSignal;
}

interface DeletingSession {
  id: string;
  userId: string;
  eveSessionId: string | null;
  startRequestedAt: Date | null;
  deletedAt: Date | null;
}

class DeletionConflict extends Error {}

/** ReservedSql имеет только запросы/release: транзакцией управляем явно. */
async function transactionOnReserved<T>(
  sql: postgres.ReservedSql,
  signal: AbortSignal,
  action: (tx: postgres.ReservedSql) => Promise<T>,
): Promise<T> {
  signal.throwIfAborted();
  try {
    // BEGIN внутри try: отмена может прийти после открытия транзакции,
    // но до возврата query, и тогда тоже нужен ROLLBACK.
    await query(sql`begin`, signal);
    const result = await action(sql);
    signal.throwIfAborted();
    await query(sql`commit`, signal);
    return result;
  } catch (error) {
    // Откат нельзя привязывать к уже отменённому сигналу. Соединение и его
    // session-level advisory locks остаются зарезервированы до завершения.
    await sql`rollback`;
    throw error;
  }
}

/**
 * Удаляет данные без проверки владельца (маршрут делает её заранее).
 * Не выпускает advisory locks, пока запросы не завершились/были остановлены.
 */
export async function deleteSessionData(
  appSessionId: string,
  options: SessionDeletionOptions = {},
): Promise<SessionDeletionResult> {
  const config = loadConfig();
  const deadline = options.deadline ?? Date.now() + 120_000;
  const timeoutMs = Math.max(1, deadline - Date.now());
  const signal = options.signal === undefined
    ? AbortSignal.timeout(timeoutMs)
    : AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)]);
  const timings: SessionDeletionResult["timings"] = {};
  // Собственный пул из одного соединения исключает ожидание места в общем
  // пуле, занятом параллельными удалениями/стартами. Транзакции короткие;
  // зарезервированное соединение держит advisory locks между ними.
  const client = postgres(config.databaseUrl, { max: 1, connect_timeout: 5, idle_timeout: 1 });
  let sql: postgres.ReservedSql | undefined;
  let deletionLocked = false;
  let creationLocked = false;
  const maintenanceToken = randomUUID();
  let maintenanceClaimed = false;
  const timed = async <T>(name: keyof typeof timings, action: () => Promise<T>): Promise<T> => {
    signal.throwIfAborted();
    const start = performance.now();
    try { return await action(); }
    finally { timings[name] = performance.now() - start; }
  };
  try {
    sql = await client.reserve();
    signal.throwIfAborted();
    await query(sql`select set_config('statement_timeout', '120000', false)`, signal);
    const [lock] = await query(sql<{ acquired: boolean }[]>`
      select pg_try_advisory_lock(2, hashtext(${appSessionId}::text)) as acquired`, signal);
    if (!lock.acquired) throw new DeletionConflict("Удаление этой сессии уже выполняется.");
    deletionLocked = true;

    const session = await timed("mark", async () => transactionOnReserved(sql!, signal, async (tx) => {
      await query(tx`select pg_advisory_xact_lock(20261110, 24)`, signal);
      await query(tx`select pg_advisory_xact_lock(20261111, hashtext(${appSessionId}))`, signal);
      const [row] = await query(tx<DeletingSession[]>`
        select id, user_id as "userId", eve_session_id as "eveSessionId",
          start_requested_at as "startRequestedAt", deleted_at as "deletedAt"
        from app_sessions where id = ${appSessionId} for update`, signal);
      if (!row) return null;
      if (!row.eveSessionId && row.startRequestedAt &&
          row.startRequestedAt.getTime() > Date.now() - 60_000) {
        throw new DeletionConflict("Сессия ещё создаётся, повторите через несколько секунд.");
      }
      await query(tx`update app_sessions set deleted_at = now(),
        sandbox_wait_generation = sandbox_wait_generation + 1
        where id = ${appSessionId} and deleted_at is null`, signal);
      await query(tx`delete from queue_entries where app_session_id = ${appSessionId}`, signal);
      return row;
    }));
    if (!session) {
      const [journal] = await query(sql<{ id: string; userId: string }[]>`
        select id, user_id as "userId" from session_deletions where id = ${appSessionId}`, signal);
      if (!journal) return { status: "not_found", timings };
      const prefix = `u/${journal.userId}/s/${journal.id}/`;
      await timed("s3Final", () => getStorage().deletePrefix(prefix, { signal }));
      await timed("database", () => query(sql!`delete from session_deletions where id = ${appSessionId}`, signal));
      console.info("[session:delete] completed", { appSessionId, timings });
      return { status: "deleted", timings };
    }

    await timed("eve", async () => {
      if (!session.eveSessionId) return;
      const stepSignal = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
      const token = await signInternalToken("eve_session_end", { sid: session.eveSessionId });
      stepSignal.throwIfAborted();
      const eve = new Client({
        host: config.internalAppUrl, redirect: "error",
        headers: { Authorization: `Bearer ${token}` },
      }).sessions.attach(session.eveSessionId);
      const cancelled = await eve.cancel({ signal: stepSignal });
      if (cancelled.status !== "accepted" && cancelled.status !== "no_active_turn") {
        throw new Error("Unexpected eve cancel result");
      }
      const reset = await eve.reset({ reason: "deleted_by_user", signal: stepSignal });
      if (reset.status !== "reset" && reset.status !== "no_active_session") {
        throw new Error("Unexpected eve reset result");
      }
    });

    await timed("daytona", async () => {
      const stepDeadline = Math.min(deadline, Date.now() + 90_000);
      const stepSignal = AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, stepDeadline - Date.now()))]);
      const lockDeadline = Math.min(stepDeadline, Date.now() + 30_000);
      while (!creationLocked) {
        const [lock] = await query(sql!<{ acquired: boolean }[]>`
          select pg_try_advisory_lock(1, hashtext(${appSessionId}::text)) as acquired`, stepSignal);
        creationLocked = lock.acquired;
        if (!creationLocked) {
          if (Date.now() >= lockDeadline) throw new Error("Sandbox creation lock timed out");
          await delay(100, undefined, { signal: stepSignal });
        }
      }
      // Смена состояния, уже принятая диспетчером, завершается прежде нашего
      // удаления. Новую остановку блокирует та же maintenance-аренда.
      while (!maintenanceClaimed) {
        maintenanceClaimed = await transactionOnReserved(sql!, stepSignal, async (tx) => {
          await query(tx`select pg_advisory_xact_lock(20261111, hashtext(${appSessionId}))`, stepSignal);
          const rows = await query(tx`update sandboxes set maintenance_token = ${maintenanceToken},
            maintenance_until = now() + interval '125 seconds'
            where app_session_id = ${appSessionId}
              and (maintenance_until is null or maintenance_until < now()) returning id`, stepSignal);
          if (rows.length) return true;
          const remaining = await query(tx`select id from sandboxes where app_session_id = ${appSessionId}`, stepSignal);
          return !remaining.length;
        });
        if (!maintenanceClaimed) await delay(100, undefined, { signal: stepSignal });
      }
      const [sandbox] = await query(sql!<{
        id: string; daytonaSandboxId: string; state: string;
        keyId: string; encrypted: string; keyDeletedAt: Date | null;
        pendingDeletion: boolean;
      }[]>`select s.id, s.daytona_sandbox_id as "daytonaSandboxId", s.state,
        k.id as "keyId", k.api_key_encrypted as encrypted, k.deleted_at as "keyDeletedAt",
        exists (select 1 from pending_sandbox_deletions p
          where p.daytona_key_id = s.daytona_key_id
            and p.daytona_sandbox_id = s.daytona_sandbox_id) as "pendingDeletion"
        from sandboxes s join daytona_keys k on k.id = s.daytona_key_id
        where s.app_session_id = ${appSessionId}`, stepSignal);
      let deletedId: string | undefined;
      if (sandbox && (sandbox.state !== "gone" || sandbox.pendingDeletion)) {
        if (!(sandbox.keyDeletedAt && sandbox.encrypted === DELETED_KEY_MARKER)) {
          const secret = decryptSecret(sandbox.encrypted, config.secretsEncryptionKey, DAYTONA_KEY_PURPOSE);
          const identity = sandbox.daytonaSandboxId ||
            (session.eveSessionId ? daytonaSandboxName(session.eveSessionId) : undefined);
          if (!identity) throw new Error("Sandbox identity missing");
          try {
            await deleteDaytonaMachine(sandbox.keyId, secret, identity, {
              signal: stepSignal, deadline: stepDeadline,
            });
          } catch (error) {
            stepSignal.throwIfAborted();
            if (!isMissingSandbox(error)) throw error;
          }
          deletedId = sandbox.daytonaSandboxId || undefined;
        }
        await query(sql!`delete from pending_sandbox_deletions
          where daytona_key_id = ${sandbox.keyId}
            and daytona_sandbox_id = ${sandbox.daytonaSandboxId}`, stepSignal);
        await recordSandboxTransition({
          sandboxId: sandbox.id, newState: "gone", source: "app",
          changes: { startingSince: null, startingKind: null, launchStartedAt: null },
          signal: stepSignal,
        });
      }
      if (session.eveSessionId || sandbox) {
        await deleteHistoricalDaytonaMachines(sql!, appSessionId, deletedId, {
          signal: stepSignal, deadline: stepDeadline,
        });
      }
      stepSignal.throwIfAborted();
    });

    const prefix = `u/${session.userId}/s/${appSessionId}/`;
    await timed("s3", () => getStorage().deletePrefix(prefix, { signal }));
    // Короткая транзакция переносит контекст повтора в журнал, который не
    // каскадируется вместе с сессией. Сеть выполняется только после commit.
    await transactionOnReserved(sql, signal, async (tx) => {
      await query(tx`insert into session_deletions (id, user_id)
        values (${appSessionId}, ${session.userId}) on conflict (id) do nothing`, signal);
      await enqueueLateUploadCleanup(tx, session, signal);
      await timed("database", () => query(tx`delete from app_sessions where id = ${appSessionId}`, signal));
      signal.throwIfAborted();
    });
    await timed("s3Final", () => getStorage().deletePrefix(prefix, { signal }));
    await query(sql`delete from session_deletions where id = ${appSessionId}`, signal);
    console.info("[session:delete] completed", { appSessionId, timings });
    return { status: "deleted", timings };
  } catch (error) {
    if (error instanceof DeletionConflict) return { status: "conflict", message: error.message, timings };
    // SDK/хранилище могут включать ключ или credentials в текст исключения.
    console.warn("[session:delete] incomplete", {
      appSessionId, steps: Object.keys(timings), timings,
      status: errorStatus(error), timedOut: signal.aborted,
    });
    return {
      status: "upstream_error",
      message: "Не удалось полностью удалить сессию. Повторите удаление.",
      timedOut: signal.aborted,
      timings,
    };
  } finally {
    // Все действия выше await-ятся; здесь не остаётся продолжающего удалять
    // Promise.race. Закрытие отдельного клиента также освобождает advisory locks.
    if (sql) {
      try {
        // При истёкшем дедлайне закрытие соединения снимает advisory locks;
        // maintenance-аренда истечёт сама. Не начинаем новую работу после него.
        if (!signal.aborted) {
          await sql`select set_config('statement_timeout', ${String(Math.max(1, Math.min(1000, deadline - Date.now())))}, false)`;
          if (maintenanceClaimed) await sql`update sandboxes set maintenance_token = null, maintenance_until = null
            where app_session_id = ${appSessionId} and maintenance_token = ${maintenanceToken}`;
          if (creationLocked) await sql`select pg_advisory_unlock(1, hashtext(${appSessionId}::text))`;
          if (deletionLocked) await sql`select pg_advisory_unlock(2, hashtext(${appSessionId}::text))`;
        }
      } catch {
        // Даже отказ очистки аренды не оставляет advisory lock в пуле.
      } finally {
        sql.release();
        await client.end({ timeout: 0 });
      }
    } else {
      await client.end({ timeout: 0 });
    }
  }
}
