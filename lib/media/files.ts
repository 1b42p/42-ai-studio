/** Общие значения медиа: срок ссылки, предел ссылок в сообщении, типы. */
import { lookup } from "mime-types";

/** Ссылка на объект S3 живёт 15 минут и создаётся заново на каждый запрос. */
export const MEDIA_URL_TTL_SECONDS = 15 * 60;

/** Не больше 20 уникальных ссылок на сообщение. */
export const MAX_MESSAGE_LINKS = 20;

/** Строка `copying` старше 15 минут считается неудачной копией. */
export const COPYING_STALE_MS = 15 * 60 * 1000;

/** Копирование уже не идёт: строка зависла дольше предела. */
export function isStaleCopying(updatedAt: Date, now = Date.now()): boolean {
  return now - updatedAt.getTime() > COPYING_STALE_MS;
}

/** Сколько хук ждёт копирования, прежде чем отпустить ход. */
export const HOOK_COPY_BUDGET_MS = 30_000;

/**
 * Типы, которые браузер показывает встроенно. Всё остальное — скачивание,
 * в том числе `text/html` и `application/pdf`.
 */
const INLINE_CONTENT_TYPES = new Set([
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/svg+xml",
]);

export function isInlineMediaType(contentType: string): boolean {
  const normalized = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return normalized.startsWith("audio/") || INLINE_CONTENT_TYPES.has(normalized);
}

/** Тип содержимого по расширению; без расширения — поток байтов. */
export function contentTypeForPath(path: string): string {
  const found = lookup(path);
  return found === false ? "application/octet-stream" : found;
}

/** Имя файла из пути песочницы. */
export function fileNameForPath(path: string): string {
  return path.split("/").at(-1) ?? "file";
}
