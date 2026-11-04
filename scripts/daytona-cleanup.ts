/**
 * Удаление песочниц Daytona, созданных приложением.
 *
 * Каждая машина помечена меткой `studio_session` с идентификатором сессии
 * приложения (`agent/lib/daytona-backend.ts`). Остановленная или архивная
 * песочница продолжает занимать лимиты аккаунта, а удаление строки
 * `sandboxes` или пользователя машину не удаляет: чистить нужно здесь.
 *
 * Использование:
 *   npm run daytona:cleanup -- --list                 # что есть в аккаунте
 *   npm run daytona:cleanup -- <appSessionId> [...]   # удалить по сессиям
 *   npm run daytona:cleanup -- --all                  # удалить все песочницы приложения
 */
import { and, eq, isNull } from "drizzle-orm";
import { Daytona, type Sandbox } from "@daytona/sdk";

import { ConfigError, loadConfig } from "../lib/config";
import { closeDb, getDb } from "../lib/db/client";
import { daytonaKeys } from "../lib/db/schema";
import { DAYTONA_KEY_PURPOSE, decryptSecret } from "../lib/secrets";

class InputError extends Error {}

/** Сессия приложения, к которой относится машина. */
function sessionOf(sandbox: Sandbox): string | undefined {
  return sandbox.labels?.studio_session;
}

async function client(): Promise<Daytona> {
  const [key] = await getDb()
    .select()
    .from(daytonaKeys)
    .where(and(eq(daytonaKeys.enabled, true), isNull(daytonaKeys.deletedAt)));
  if (key === undefined) {
    throw new InputError("Нет включённого неудалённого ключа Daytona: добавьте его командой npm run daytona:add-key.");
  }

  const config = loadConfig();
  return new Daytona({
    apiKey: decryptSecret(key.apiKeyEncrypted, config.secretsEncryptionKey, DAYTONA_KEY_PURPOSE),
    apiUrl: config.daytonaApiUrl,
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    throw new InputError(
      "Использование: npm run daytona:cleanup -- --list | <appSessionId> [...] | --all",
    );
  }

  const daytona = await client();

  if (args[0] === "--list") {
    let count = 0;
    for await (const sandbox of daytona.list({ limit: 100 })) {
      count += 1;
      console.log(
        `${sandbox.id}\t${sandbox.state ?? "?"}\t${sandbox.createdAt ?? "?"}\t${sessionOf(sandbox) ?? "без метки"}`,
      );
    }
    if (count === 0) console.log("Песочниц нет.");
    return;
  }

  const all = args[0] === "--all";
  const sessions = new Set(args);
  let deleted = 0;
  for await (const sandbox of daytona.list({ limit: 100 })) {
    const session = sessionOf(sandbox);
    if (session === undefined) continue;
    if (!all && !sessions.has(session)) continue;

    await sandbox.delete(300, true);
    deleted += 1;
    console.log(`Удалена песочница ${sandbox.id} (сессия ${session}, была ${sandbox.state ?? "?"}).`);
  }

  console.log(deleted === 0 ? "Нечего удалять." : `Удалено песочниц: ${deleted}.`);
}

try {
  await main();
} catch (error) {
  // Не выводим исключения драйвера, SQL-параметры и строки подключения.
  if (error instanceof ConfigError || error instanceof InputError) console.error(error.message);
  else console.error("Не удалось удалить песочницы Daytona. Проверьте ключ, сеть и доступность API.");
  process.exitCode = 1;
} finally {
  try {
    await closeDb();
  } catch {
    console.error("Не удалось закрыть подключение к базе.");
    process.exitCode = 1;
  }
}
