/**
 * Клиент Drizzle к Postgres: один пул на процесс, создаётся лениво.
 * Строка подключения приходит из модуля конфигурации, `process.env` здесь нет.
 *
 * Пул postgres.js по умолчанию (до 10 соединений): `sql.begin` занимает
 * соединение на всё время транзакции, и при одном соединении запрос вне её
 * из колбэка ждал бы бесконечно. В dev клиент живёт на `globalThis`, иначе
 * горячая перезагрузка Next.js плодит новые пулы.
 */
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { loadConfig } from "../config";
import * as schema from "./schema";

export type Database = PostgresJsDatabase<typeof schema>;

interface DbState {
  sql: postgres.Sql;
  database: Database;
  /** Отдельный пул для долгих рекомендательных блокировок старта песочниц. */
  lockSql?: postgres.Sql;
}

const globalForDb = globalThis as typeof globalThis & { __studioDb?: DbState };

let state: DbState | undefined = globalForDb.__studioDb;

function ensureState(): DbState {
  if (state === undefined) {
    const sql = postgres(loadConfig().databaseUrl);
    state = { sql, database: drizzle(sql, { schema }) };
    if (process.env.NODE_ENV !== "production") globalForDb.__studioDb = state;
  }
  return state;
}

export function getDb(): Database {
  return ensureState().database;
}

/** Пул процесса (для разовых запросов обвязки). */
export function getSqlClient(): postgres.Sql {
  return ensureState().sql;
}

/**
 * Отдельный пул для `pg_advisory_lock` старта песочницы. Блокировка держится
 * всё создание машины (до 15 минут), поэтому её соединение не должно
 * занимать общий пул: иначе несколько одновременных стартов займут все
 * соединения и будут ждать запросов, которым нужен тот же пул.
 */
export function getLockSqlClient(): postgres.Sql {
  const current = ensureState();
  current.lockSql ??= postgres(loadConfig().databaseUrl, { max: 16 });
  return current.lockSql;
}

/** Закрывает пулы процесса. */
export async function closeDb(): Promise<void> {
  const current = state;
  state = undefined;
  delete globalForDb.__studioDb;
  if (current === undefined) return;
  await Promise.allSettled([
    current.sql.end(),
    ...(current.lockSql === undefined ? [] : [current.lockSql.end()]),
  ]);
}
