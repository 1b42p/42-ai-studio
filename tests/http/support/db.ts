/**
 * Работа с тестовой базой: клиент Drizzle, очистка, вставка пользователя,
 * счётчики журнала миграций. Правило безопасности: тесты работают только
 * с базой, имя которой оканчивается на `_test`.
 */
import { loadConfig } from "../../../lib/config";
import { getDb, getSqlClient, type Database } from "../../../lib/db/client";
import { daytonaKeys, users, type DaytonaKey, type NewDaytonaKey, type User } from "../../../lib/db/schema";
import { DAYTONA_KEY_PURPOSE, encryptSecret } from "../../../lib/secrets";

/** Клиент Drizzle к тестовой базе (клиент приложения, один на процесс воркера). */
export function db(): Database {
  return getDb();
}

/** Имя базы данных из `DATABASE_URL`. */
export function databaseName(databaseUrl: string): string {
  return decodeURIComponent(new URL(databaseUrl).pathname.replace(/^\//, ""));
}

/**
 * Отказывается работать, если имя базы в `DATABASE_URL` не оканчивается
 * на `_test`: тесты не должны иметь доступа к рабочим данным.
 */
export function assertTestDatabaseName(databaseUrl: string): void {
  const name = databaseName(databaseUrl);
  if (!name.endsWith("_test")) {
    throw new Error(
      `Тесты работают только с базой *_test, а получена база «${name}»: ` +
        "чтобы случайно не стереть рабочие данные, запуск остановлен",
    );
  }
}

/**
 * `TRUNCATE … CASCADE` всех таблиц схемы `public`, кроме служебных таблиц
 * drizzle (журнал миграций живёт в схеме `drizzle` и не трогается). Вызывается
 * автоматически перед каждым тестовым файлом.
 */
export async function resetDatabase(): Promise<void> {
  assertTestDatabaseName(loadConfig().databaseUrl);
  const client = getSqlClient();
  const tables = (await client`
    select tablename from pg_tables
    where schemaname = 'public' and tablename <> '__drizzle_migrations'
  `) as Array<{ tablename: string }>;
  if (tables.length === 0) return;
  const names = tables.map((row) => `"${row.tablename}"`).join(", ");
  await client.unsafe(`truncate table ${names} cascade`);
}

let userSeq = 0;

/** Счётчик строк запросом к базе. */
async function count(statement: string): Promise<number> {
  const rows = (await getSqlClient().unsafe(statement)) as Array<{ count: string }>;
  return Number(rows[0].count);
}

/** Вставляет строку `users` и возвращает её. */
export async function createUser(
  overrides: Partial<Omit<User, "id" | "createdAt">> = {},
): Promise<User> {
  userSeq += 1;
  const [inserted] = await db()
    .insert(users)
    .values({
      telegramId: Date.now() * 1000 + (userSeq % 1000),
      name: `Тестовый пользователь ${userSeq}`,
      isOperator: false,
      isBlocked: false,
      ...overrides,
    })
    .returning();
  return inserted;
}

/** Добавляет зашифрованный ключ; открытый apiKey существует только при подготовке. */
export async function createDaytonaKey(
  overrides: Partial<Omit<NewDaytonaKey, "apiKeyEncrypted">> & { apiKey?: string } = {},
): Promise<DaytonaKey> {
  const { apiKey = "dtn_test_secret_value", ...values } = overrides;
  const [inserted] = await db().insert(daytonaKeys).values({
    label: "test",
    enabled: true,
    ...values,
    apiKeyEncrypted: encryptSecret(apiKey, loadConfig().secretsEncryptionKey, DAYTONA_KEY_PURPOSE),
  }).returning();
  return inserted;
}

/** Сколько пользователей в таблице. */
export async function userCount(): Promise<number> {
  return count("select count(*) as count from users");
}

/** Сколько строк в журнале миграций drizzle. */
export async function migrationJournalCount(): Promise<number> {
  return count("select count(*) as count from drizzle.__drizzle_migrations");
}
