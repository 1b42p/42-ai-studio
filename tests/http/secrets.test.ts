import { describe, expect, test } from "vitest";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";

import { DAYTONA_KEY_PURPOSE, decryptSecret, encryptSecret } from "../../lib/secrets";
import { loadConfig, loadDotenvFiles } from "../../lib/config";
import { getDb } from "../../lib/db/client";
import { daytonaKeys } from "../../lib/db/schema";

const key = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

describe("шифрование секретов", () => {
  test("возвращает исходное значение и не хранит открытый секрет", () => {
    const value = "dtn_секрет_для_проверки";
    const encrypted = encryptSecret(value, key, DAYTONA_KEY_PURPOSE);
    expect(encrypted).toMatch(/^v1:/);
    expect(encrypted).not.toContain(value);
    expect(decryptSecret(encrypted, key, DAYTONA_KEY_PURPOSE)).toBe(value);
  });

  test("повторное шифрование одного значения использует свежий IV", () => {
    const first = encryptSecret("secret", key, DAYTONA_KEY_PURPOSE);
    const second = encryptSecret("secret", key, DAYTONA_KEY_PURPOSE);
    expect(first).not.toBe(second);
    expect(Buffer.from(first.slice(3), "base64").subarray(0, 12)).not.toEqual(
      Buffer.from(second.slice(3), "base64").subarray(0, 12),
    );
  });

  test("неверный ключ и другое назначение не раскрывают значение", () => {
    const encrypted = encryptSecret("secret", key, DAYTONA_KEY_PURPOSE);
    const otherKey = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=";
    expect(() => decryptSecret(encrypted, otherKey, DAYTONA_KEY_PURPOSE)).toThrow();
    expect(() => decryptSecret(encrypted, key, "another-purpose")).toThrow();
  });

  test("изменение любого участка payload отвергается", () => {
    const encrypted = encryptSecret("secret", key, DAYTONA_KEY_PURPOSE);
    for (const offset of [0, 12, 28]) {
      const bytes = Buffer.from(encrypted.slice(3), "base64");
      bytes[offset] ^= 1;
      expect(() => decryptSecret(`v1:${bytes.toString("base64")}`, key, DAYTONA_KEY_PURPOSE)).toThrow();
    }
  });

  test("не принимает неверную версию и неканонический или обрезанный payload", () => {
    const encrypted = encryptSecret("secret", key, DAYTONA_KEY_PURPOSE);
    for (const invalid of [
      encrypted.replace("v1:", "v2:"), `${encrypted}\n`, `${encrypted}!`,
      encrypted.replace("v1:", "v1: "), "v1:", "v1:AA==", "v1:AB==",
      "v1:" + "_".repeat(40), "v1:" + "A".repeat(39),
    ]) {
      expect(() => decryptSecret(invalid, key, DAYTONA_KEY_PURPOSE)).toThrow();
    }
  });

  test("ключ — строго канонический base64 ровно 32 байт", () => {
    const encrypted = encryptSecret("secret", key, DAYTONA_KEY_PURPOSE);
    for (const invalid of ["", "AA==", key.slice(0, -1), `${key}\n`, `${key}!`,
      "A".repeat(42) + "B=", "/".repeat(43) + "=", "_".repeat(43) + "=",
      Buffer.alloc(33).toString("base64")]) {
      expect(() => encryptSecret("secret", invalid, DAYTONA_KEY_PURPOSE)).toThrow("SECRETS_ENCRYPTION_KEY");
      expect(() => decryptSecret(encrypted, invalid, DAYTONA_KEY_PURPOSE)).toThrow("SECRETS_ENCRYPTION_KEY");
    }
  });

  test("поддерживает пустое значение, но не пустое назначение", () => {
    expect(decryptSecret(encryptSecret("", key, "purpose"), key, "purpose")).toBe("");
    expect(() => encryptSecret("secret", key, "")).toThrow();
  });
});

describe("CLI добавления ключа Daytona", () => {
  test("принимает секрет через stdin и сохраняет только шифротекст", async () => {
    const label = `cli-${randomUUID()}`;
    const secret = "dtn_cli_test_secret_value";
    // Тестовая обвязка передаёт окружение дочернему процессу явно:
    // локальный .env разработчика не должен перекрыть тестовую базу.
    const env = { ...process.env };
    for (const file of [...loadDotenvFiles()].reverse()) {
      if (file.path === ".env.test" || file.path === ".env.test.local") {
        Object.assign(env, file.env);
      }
    }
    env.NODE_ENV = "test";
    const child = spawn(process.execPath, ["--import", "tsx", "scripts/add-daytona-key.ts", label], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    const exited = new Promise<number | null>((resolve, reject) => {
      child.once("exit", resolve);
      child.once("error", reject);
    });
    child.stdin.end(`${secret}\n`);
    try {
      expect(await exited, output).toBe(0);
      expect(output).not.toContain(secret);
      const [row] = await getDb().select().from(daytonaKeys).where(eq(daytonaKeys.label, label));
      expect(row).toBeDefined();
      expect(JSON.stringify(row)).not.toContain(secret);
      expect(decryptSecret(row.apiKeyEncrypted, loadConfig().secretsEncryptionKey, DAYTONA_KEY_PURPOSE)).toBe(secret);
    } finally {
      child.kill();
      await getDb().delete(daytonaKeys).where(eq(daytonaKeys.label, label));
    }
  });
});
