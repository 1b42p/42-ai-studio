/**
 * Глобальная подготовка HTTP-тестов: база, бакет, миграции, основной экземпляр.
 *
 * Тесты работают только с базой `*_test`, поэтому перед созданием базы
 * проверяется её имя — чтобы случайно не стереть рабочие данные.
 */
import { rmSync } from "node:fs";

import type { TestProject } from "vitest/node";

import { loadConfig } from "../../lib/config";
import { closeDb } from "../../lib/db/client";
import { getStorage } from "../../lib/s3";
import { APP_LOG_FILE, startApp, type AppHandle } from "./support/app";
import {
  assertTestDatabaseName,
  databaseName,
  migrationJournalCount,
  resetDatabase,
} from "./support/db";
import { startEdgeTtsServer, type EdgeTtsServer } from "./support/edge-tts-server";
import { startOidcIssuer, type OidcIssuer } from "./support/oidc-issuer";
import { startTavilyServer, type TavilyServer } from "./support/tavily-server";

let app: AppHandle | undefined;
let oidcIssuer: OidcIssuer | undefined;
let edgeTts: EdgeTtsServer | undefined;
let tavily: TavilyServer | undefined;

/** Создаёт тестовую базу через служебную базу `postgres`, если её ещё нет. */
async function ensureDatabase(databaseUrl: string): Promise<void> {
  const name = databaseName(databaseUrl);
  const maintenance = new URL(databaseUrl);
  maintenance.pathname = "/postgres";

  const postgres = (await import("postgres")).default;
  const admin = postgres(maintenance.toString(), { max: 1 });
  try {
    const rows = await admin`select 1 from pg_database where datname = ${name}`;
    if (rows.length > 0) return;
    // Имя базы приходит из нашей же конфигурации; кавычки экранируются.
    await admin.unsafe(`create database "${name.replace(/"/g, '""')}"`);
  } finally {
    await admin.end();
  }
}

/** Применяет миграции из каталога `drizzle`. */
async function applyMigrations(): Promise<void> {
  const { migrate } = await import("drizzle-orm/postgres-js/migrator");
  const { getDb } = await import("../../lib/db/client");
  await migrate(getDb() as never, { migrationsFolder: "./drizzle" });
}

export async function setup(project: TestProject): Promise<void> {
  const config = loadConfig();
  assertTestDatabaseName(config.databaseUrl);

  await ensureDatabase(config.databaseUrl);
  await getStorage().ensureBucket();
  await applyMigrations();
  await resetDatabase();

  const journal = await migrationJournalCount();
  if (journal === 0) {
    throw new Error("журнал миграций пуст: миграции не применились");
  }

  const edgePort = config.edgeTtsWssUrl === undefined ? 59101 : Number(new URL(config.edgeTtsWssUrl).port);
  edgeTts = await startEdgeTtsServer(edgePort);
  tavily = await startTavilyServer(Number(new URL(config.tavilyApiUrl).port));

  oidcIssuer = await startOidcIssuer(config.telegramOidcIssuer, {
    appUrl: config.appUrl,
    clientId: config.telegramClientId ?? "",
    clientSecret: config.telegramClientSecret ?? "",
  });

  // Журнал предыдущего прогона не должен смешиваться с текущим.
  rmSync(APP_LOG_FILE, { force: true });

  app = await startApp({
    port: config.testAppPort,
    logFile: APP_LOG_FILE,
  });
  project.provide("appUrl", app.url);
}

export async function teardown(): Promise<void> {
  await app?.stop();
  await oidcIssuer?.close();
  await edgeTts?.close();
  await tavily?.close();
  await closeDb();
}
