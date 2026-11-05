/**
 * Удаление песочниц Daytona, созданных приложением.
 *
 * Каждая машина помечена меткой `studio_session` с идентификатором сессии
 * приложения (`agent/lib/daytona-backend.ts`). Остановленная или архивная
 * песочница продолжает занимать лимиты аккаунта, а удаление строки
 * `sandboxes` или пользователя машину не удаляет: чистить нужно здесь.
 *
 * Ключ Daytona видит только свою организацию, поэтому команда обходит все
 * ключи пула и дедуплицирует машины по id: разные ключи одной организации
 * видят одно и то же.
 *
 * Использование:
 *   npm run daytona:cleanup -- --list                 # что есть в аккаунте
 *   npm run daytona:cleanup -- <appSessionId> [...]   # удалить по сессиям
 *   npm run daytona:cleanup -- --all                  # удалить все песочницы приложения
 */
import { Daytona, type Sandbox } from "@daytona/sdk";

import { ConfigError, loadConfig } from "../lib/config";
import { closeDb, getDb } from "../lib/db/client";
import { daytonaKeys } from "../lib/db/schema";
import { storedUsage } from "../lib/daytona/usage";
import { DAYTONA_KEY_PURPOSE, decryptSecret } from "../lib/secrets";

class InputError extends Error {}

interface KeyClient {
  label: string;
  daytona: Daytona;
}

/** Сессия приложения, к которой относится машина. */
function sessionOf(sandbox: Sandbox): string | undefined {
  return sandbox.labels?.studio_session;
}

/**
 * Клиент на каждый рабочий ключ. Ключи одной организации видят одни и те же
 * машины, их отсекает дедупликация по id; зато отозванный ключ не скрывает
 * организацию, если рядом есть живой ключ.
 */
async function clients(): Promise<KeyClient[]> {
  const keys = await getDb()
    .select()
    .from(daytonaKeys)
    .orderBy(daytonaKeys.createdAt);
  const config = loadConfig();
  const result: KeyClient[] = [];
  for (const key of keys) {
    if (key.apiKeyEncrypted === "deleted") continue;
    if (storedUsage(key.usage)?.error === "unauthorized") continue;
    let secret: string;
    try {
      secret = decryptSecret(key.apiKeyEncrypted, config.secretsEncryptionKey, DAYTONA_KEY_PURPOSE);
    } catch {
      console.error(`Ключ «${key.label}» пропущен: шифротекст не читается.`);
      continue;
    }
    result.push({
      label: key.label,
      daytona: new Daytona({ apiKey: secret, apiUrl: config.daytonaApiUrl }),
    });
  }
  if (result.length === 0) {
    throw new InputError("Нет рабочего ключа Daytona: добавьте его командой npm run daytona:add-key.");
  }
  return result;
}

/** Обходит машины всех организаций пула; одинаковые id пропускает. */
async function eachSandbox(
  daytonaClients: readonly KeyClient[],
  visit: (sandbox: Sandbox, label: string) => Promise<void>,
): Promise<boolean> {
  const seen = new Set<string>();
  let failed = false;
  for (const { label, daytona } of daytonaClients) {
    try {
      for await (const sandbox of daytona.list({ limit: 100 })) {
        if (seen.has(sandbox.id)) continue;
        seen.add(sandbox.id);
        await visit(sandbox, label);
      }
    } catch {
      // Ошибка одного ключа не должна мешать почистить остальные организации.
      console.error(`Не удалось прочитать песочницы ключа «${label}».`);
      failed = true;
    }
  }
  return failed;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    throw new InputError(
      "Использование: npm run daytona:cleanup -- --list | <appSessionId> [...] | --all",
    );
  }

  const daytonaClients = await clients();

  if (args[0] === "--list") {
    let count = 0;
    const failed = await eachSandbox(daytonaClients, async (sandbox, label) => {
      count += 1;
      console.log(
        `${sandbox.id}\t${sandbox.state ?? "?"}\t${sandbox.createdAt ?? "?"}\t${sessionOf(sandbox) ?? "без метки"}\t${label}`,
      );
    });
    if (count === 0) console.log("Песочниц нет.");
    if (failed) process.exitCode = 1;
    return;
  }

  const all = args[0] === "--all";
  const sessions = new Set(args);
  let deleted = 0;
  let failed = false;
  const listingFailed = await eachSandbox(daytonaClients, async (sandbox, label) => {
    const session = sessionOf(sandbox);
    if (session === undefined) return;
    if (!all && !sessions.has(session)) return;

    try {
      await sandbox.delete(300, true);
      deleted += 1;
      console.log(
        `Удалена песочница ${sandbox.id} (сессия ${session}, была ${sandbox.state ?? "?"}, ключ «${label}»).`,
      );
    } catch {
      console.error(`Не удалось удалить песочницу ${sandbox.id} (сессия ${session}).`);
      failed = true;
    }
  });
  failed ||= listingFailed;

  console.log(deleted === 0 ? "Нечего удалять." : `Удалено песочниц: ${deleted}.`);
  if (failed) process.exitCode = 1;
}

try {
  await main();
} catch (error) {
  // Не выводим исключения драйвера, SQL-параметры и строки подключения.
  if (error instanceof ConfigError || error instanceof InputError) console.error(error.message);
  else console.error("Не удалось удалить песочницы Daytona. Проверьте ключи, сеть и доступность API.");
  process.exitCode = 1;
} finally {
  try {
    await closeDb();
  } catch {
    console.error("Не удалось закрыть подключение к базе.");
    process.exitCode = 1;
  }
}
