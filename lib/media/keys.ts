/**
 * Ключи объектов S3 и метаданные медиа (#8). Формат ключа один на проект:
 * `u/<user_id>/s/<app_session_id>/<вид>/<uuid>/<имя файла>`.
 */
import { randomUUID } from "node:crypto";

import type { MediaKind } from "@/lib/db/schema";

/** Вид медиа → сегмент ключа. */
export const MEDIA_KIND_SEGMENTS: Record<MediaKind, string> = {
  upload: "uploads",
  tool_media: "tool-media",
  message_file: "message-files",
  preview: "preview",
};

/** Имя файла без пути и управляющих символов: пустое заменяется на `file`. */
export function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).at(-1) ?? "";
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return cleaned.length === 0 || cleaned === "." || cleaned === ".." ? "file" : cleaned.slice(0, 200);
}

export function mediaObjectKey(input: {
  userId: string;
  appSessionId: string;
  kind: MediaKind;
  name: string;
}): string {
  return `u/${input.userId}/s/${input.appSessionId}/${MEDIA_KIND_SEGMENTS[input.kind]}/${randomUUID()}/${safeFileName(input.name)}`;
}
