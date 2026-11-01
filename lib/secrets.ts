import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export const DAYTONA_KEY_PURPOSE = "daytona-api-key";

/** Buffer.from допускает мусор, пробелы и base64url: принимаем только канонический base64. */
function decodeBase64(value: string): Buffer {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error("Некорректный формат секрета");
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) throw new Error("Некорректный формат секрета");
  return bytes;
}

/** Проверка общего ключа, в том числе при загрузке конфигурации. */
export function isValidSecretsEncryptionKey(value: string): boolean {
  try {
    return value.length === 44 && decodeBase64(value).length === 32;
  } catch {
    return false;
  }
}

function decodeKey(value: string): Buffer {
  if (!isValidSecretsEncryptionKey(value)) {
    throw new Error("SECRETS_ENCRYPTION_KEY: ожидается 32 байта в каноническом base64");
  }
  return decodeBase64(value);
}

function aad(purpose: string): Buffer {
  if (purpose.length === 0) throw new Error("Не задано назначение секрета");
  return Buffer.from(`v1:${purpose}`, "utf8");
}

/** AES-256-GCM: v1:base64(IV[12] || tag[16] || ciphertext). */
export function encryptSecret(value: string, keyBase64: string, purpose: string): string {
  const key = decodeKey(keyBase64);
  try {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
    cipher.setAAD(aad(purpose));
    const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return `v1:${Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64")}`;
  } finally {
    key.fill(0);
  }
}

/** Никакой части открытого текста не возвращается до проверки тега. */
export function decryptSecret(ciphertext: string, keyBase64: string, purpose: string): string {
  const key = decodeKey(keyBase64);
  try {
    if (!ciphertext.startsWith("v1:")) throw new Error("Неподдерживаемая версия секрета");
    const payload = decodeBase64(ciphertext.slice(3));
    if (payload.length < 28) throw new Error("Некорректный формат секрета");
    const decipher = createDecipheriv("aes-256-gcm", key, payload.subarray(0, 12), {
      authTagLength: 16,
    });
    decipher.setAAD(aad(purpose));
    decipher.setAuthTag(payload.subarray(12, 28));
    return Buffer.concat([decipher.update(payload.subarray(28)), decipher.final()]).toString("utf8");
  } catch {
    // Не отдаём вызывающему исключения OpenSSL и никакие входные значения.
    throw new Error("Не удалось расшифровать секрет");
  } finally {
    key.fill(0);
  }
}
