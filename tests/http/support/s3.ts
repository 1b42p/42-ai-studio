/**
 * Клиент тестового бакета для проверок. Бакет очищается вызовом
 * `deletePrefix("")` перед каждым тестовым файлом — как и база.
 */
import { loadConfig } from "../../../lib/config";
import { Storage } from "../../../lib/s3";

export interface TestS3 {
  /** Содержимое объекта целиком. */
  getBytes(key: string): Promise<Uint8Array>;
  /** Есть ли объект. */
  exists(key: string): Promise<boolean>;
  /** Ключи объектов под префиксом. */
  listKeys(prefix: string): Promise<string[]>;
  /** Размер и тип объекта; `null` — объекта нет. */
  info(key: string): Promise<{ size: number; contentType: string | undefined } | null>;
  /** Загрузка объекта. */
  put(key: string, bytes: Uint8Array | string, contentType?: string): Promise<void>;
  /** Удаление всех объектов по префиксу; пустой префикс чистит весь бакет. */
  deletePrefix(prefix: string): Promise<number>;
}

export function s3(): TestS3 {
  const storage = new Storage(loadConfig());
  return {
    getBytes: (key) => storage.getObject(key),
    exists: (key) => storage.objectExists(key),
    info: (key) => storage.objectInfo(key),
    listKeys: (prefix) => storage.listKeys(prefix),
    put: (key, bytes, contentType) => storage.putObject(key, bytes, contentType),
    deletePrefix: (prefix) => storage.deletePrefix(prefix),
  };
}
