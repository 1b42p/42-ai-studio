/**
 * Удаление пользователя со всеми данными. Операция необратима, поэтому идёт
 * идемпотентными шагами: пометка, пачки сессий через `deleteSessionData`,
 * очистка префикса S3, удаление строки `users` с каскадом. Повторный запрос
 * продолжает с места остановки.
 */
import postgres from "postgres";

import { loadConfig } from "@/lib/config";
import { getStorage, type Storage } from "@/lib/s3";
import { deleteSessionData, type SessionDeletionResult } from "@/lib/sessions/delete";
import { errorStatus } from "@/lib/sandbox/errors";

const SESSIONS_PER_BATCH = 5;
const BATCH_BUDGET_MS = 90_000;
const REQUEST_BUDGET_MS = 120_000;

export type DeleteUserResult =
  | { readonly status: "deleted" }
  | {
      readonly status: "progress";
      readonly deleted: number;
      readonly total: number;
      readonly remaining: number;
    }
  | { readonly status: "not_found" }
  | { readonly status: "conflict"; readonly message: string }
  | { readonly status: "busy"; readonly message: string }
  | { readonly status: "failed"; readonly message: string };

export interface DeleteUserOptions {
  /** Подмена хранилища S3 для проверки шага очистки. */
  readonly storage?: Pick<Storage, "deletePrefix">;
}

interface Target {
  id: string;
  isOperator: boolean;
}

interface SessionRow {
  id: string;
}

/**
 * Снимает блокировку класса 4 и закрывает собственный пул. Выражение unlock
 * нельзя оставлять только на `release()`: возврат соединения в пул сохраняет
 * сеансовую блокировку.
 */
async function releaseUserLock(
  sql: postgres.ReservedSql | undefined,
  client: postgres.Sql,
  userId: string,
  locked: boolean,
): Promise<void> {
  if (sql !== undefined && locked) {
    try {
      await sql`select pg_advisory_unlock(4, hashtext(${userId}::text))`;
    } catch {
      // Закрытие соединения всё равно снимет сеансовую блокировку.
    }
  }
  sql?.release();
  await client.end({ timeout: 0 });
}

export async function deleteUserData(
  userId: string,
  operatorId: string,
  options: DeleteUserOptions = {},
): Promise<DeleteUserResult> {
  const config = loadConfig();
  const storage = options.storage ?? getStorage();
  const requestDeadline = Date.now() + REQUEST_BUDGET_MS;
  // Отдельный пул из одного соединения: сеансовая блокировка не занимает общий
  // пул на время сетевых шагов удаления.
  const client = postgres(config.databaseUrl, { max: 1, connect_timeout: 5, idle_timeout: 1 });
  let sql: postgres.ReservedSql | undefined;
  let locked = false;

  try {
    sql = await client.reserve();
    const [lock] = await sql<{ acquired: boolean }[]>`
      select pg_try_advisory_lock(4, hashtext(${userId}::text)) as acquired`;
    if (!lock.acquired) {
      return { status: "busy", message: "Удаление этого пользователя уже выполняется." };
    }
    locked = true;

    const [target] = await sql<Target[]>`
      select id, is_operator as "isOperator" from users where id = ${userId}`;
    if (!target) return { status: "not_found" };
    if (target.isOperator) {
      return {
        status: "conflict",
        message: "Нельзя удалить оператора. Сначала снимите флаг оператора в базе.",
      };
    }

    console.info("[admin:user] delete started", { operatorId, userId });

    // Пометка и выход из всех сеансов — до сетевых шагов: пользователь сразу
    // теряет доступ, а повтор продолжит с этого состояния.
    await sql`
      update users
      set is_blocked = true,
        deletion_requested_at = coalesce(deletion_requested_at, now())
      where id = ${userId}`;
    await sql`delete from auth_sessions where user_id = ${userId}`;

    // Финальный S3 sweep и удаление журнала Workflow могут ещё ждать повтора
    // после каскада app_sessions. Не удаляем их журнал вместе с владельцем.
    const sessionCount = async (connection: postgres.ReservedSql) => {
      const [row] = await connection<{ total: number }[]>`
        select (
          (select count(*) from app_sessions where user_id = ${userId}) +
          (select count(*) from session_deletions where user_id = ${userId})
        )::int as total`;
      return row?.total ?? 0;
    };
    const total = await sessionCount(sql);

    const batch = await sql<SessionRow[]>`
      select id from (
        select id, created_at, deleted_at is null as fresh
        from app_sessions where user_id = ${userId}
        union all
        select id, created_at, false as fresh
        from session_deletions where user_id = ${userId}
      ) as pending
      order by fresh desc, created_at, id
      limit ${SESSIONS_PER_BATCH}`;

    const batchDeadline = Math.min(requestDeadline, Date.now() + BATCH_BUDGET_MS);
    const failed = new Set<string>();
    let deleted = 0;

    for (const session of batch) {
      if (Date.now() >= batchDeadline) break;
      let result: SessionDeletionResult;
      try {
        // Дедлайн пачки передаётся внутрь: медленная сессия не выходит за
        // бюджет запроса, а её таймаут означает «осталась на следующий 202».
        result = await deleteSessionData(session.id, { deadline: batchDeadline });
      } catch (error) {
        failed.add(session.id);
        console.warn("[admin:user] session delete failed", {
          userId,
          appSessionId: session.id,
          status: errorStatus(error),
        });
        continue;
      }
      if (result.timedOut) break;
      if (result.status === "deleted" || result.status === "not_found") deleted += 1;
      else if (result.status === "upstream_error") failed.add(session.id);
      // `conflict` — сессию удаляет другой запрос; это пропуск без сбоя.
    }

    const remaining = await sessionCount(sql);

    if (failed.size > 0) {
      console.warn("[admin:user] delete incomplete", {
        operatorId,
        userId,
        reason: "sessions",
        failed: failed.size,
      });
      return {
        status: "failed",
        message: `Не удалось удалить часть данных (сессий: ${failed.size}). Повторите удаление.`,
      };
    }

    if (remaining > 0) {
      return { status: "progress", deleted, total, remaining };
    }

    const signal = AbortSignal.timeout(Math.max(1, requestDeadline - Date.now()));
    try {
      await storage.deletePrefix(`u/${userId}/`, { signal });
    } catch (error) {
      console.warn("[admin:user] delete incomplete", {
        operatorId,
        userId,
        reason: "storage",
        status: errorStatus(error),
      });
      return {
        status: "failed",
        message: "Не удалось удалить файлы пользователя. Повторите удаление.",
      };
    }

    // Каскад убирает auth_sessions, usage_records, mcp_servers, user_memory и
    // остальные таблицы с user_id. Условие по метке не даёт удалить строку,
    // которую кто-то успел вернуть в обычное состояние.
    const removed = await sql<{ id: string }[]>`
      delete from users where id = ${userId} and deletion_requested_at is not null
      returning id`;
    if (removed.length === 0) return { status: "not_found" };

    console.info("[admin:user] delete completed", { operatorId, userId });
    return { status: "deleted" };
  } catch (error) {
    console.warn("[admin:user] delete incomplete", {
      operatorId,
      userId,
      reason: "unexpected",
      status: errorStatus(error),
    });
    return {
      status: "failed",
      message: "Не удалось полностью удалить пользователя. Повторите удаление.",
    };
  } finally {
    await releaseUserLock(sql, client, userId, locked);
  }
}
