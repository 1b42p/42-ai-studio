import { ConfigError, loadConfig } from "../lib/config";
import { closeDb, getDb } from "../lib/db/client";
import { daytonaKeys } from "../lib/db/schema";
import { DAYTONA_KEY_PURPOSE, encryptSecret } from "../lib/secrets";

class InputError extends Error {}

async function main(): Promise<void> {
  const [label, ...extra] = process.argv.slice(2);
  if (!label?.trim() || extra.length > 0) {
    throw new InputError("Использование: npm run daytona:add-key -- <метка>; секрет передайте в stdin.");
  }
  if (process.stdin.isTTY) {
    throw new InputError("Передайте секрет через стандартный ввод из файла или защищённого канала, не в аргументах.");
  }
  const config = loadConfig();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of process.stdin) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > 65_536) {
        bytes.fill(0);
        throw new InputError("Слишком длинный ключ в стандартном вводе.");
      }
      chunks.push(bytes);
    }
    const input = Buffer.concat(chunks);
    const secret = input.toString("utf8").trim();
    input.fill(0);
    if (!secret || /\s/.test(secret)) {
      throw new InputError("Стандартный ввод должен содержать один непустой ключ без пробелов.");
    }
    const [row] = await getDb().insert(daytonaKeys).values({
      label: label.trim(),
      apiKeyEncrypted: encryptSecret(secret, config.secretsEncryptionKey, DAYTONA_KEY_PURPOSE),
    }).returning({ id: daytonaKeys.id });
    console.log(`Ключ Daytona добавлен: ${row.id}`);
  } finally {
    for (const chunk of chunks) chunk.fill(0);
  }
}

try {
  await main();
} catch (error) {
  // Не выводим исключения драйвера, SQL-параметры и строки подключения.
  if (error instanceof ConfigError || error instanceof InputError) console.error(error.message);
  else console.error("Не удалось добавить ключ Daytona. Проверьте метку, stdin, конфигурацию и доступность базы.");
  process.exitCode = 1;
} finally {
  try {
    await closeDb();
  } catch {
    console.error("Не удалось закрыть подключение к базе.");
    process.exitCode = 1;
  }
}
