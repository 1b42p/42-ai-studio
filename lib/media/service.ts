/** Чтение медиа и файлов сообщений для HTTP-маршрутов (#8). */
import { eq } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import { media, messageFiles, type Media } from "@/lib/db/schema";

import { fileNameForPath, isStaleCopying } from "./files";
import type { MessageFileView } from "./types";

/** Медиа пользователя; чужое и несуществующее неразличимы. */
export async function findMediaForUser(id: string, userId: string): Promise<Media | null> {
  const [record] = await getDb()
    .select()
    .from(media)
    .where(eq(media.id, id))
    .limit(1);
  return record !== undefined && record.userId === userId ? record : null;
}

/**
 * Все файлы сессии по сообщениям. Зависшая `copying` старше 15 минут
 * показывается как `missing`/`copy_failed`: копирование уже не идёт.
 */
export async function listSessionFiles(appSessionId: string): Promise<MessageFileView[]> {
  const rows = await getDb()
    .select({
      messageId: messageFiles.messageId,
      path: messageFiles.sandboxPath,
      state: messageFiles.state,
      reason: messageFiles.reason,
      updatedAt: messageFiles.updatedAt,
      mediaId: messageFiles.mediaId,
      contentType: media.contentType,
      name: media.originalName,
      sizeBytes: media.sizeBytes,
    })
    .from(messageFiles)
    .leftJoin(media, eq(media.id, messageFiles.mediaId))
    .where(eq(messageFiles.appSessionId, appSessionId))
    .orderBy(messageFiles.createdAt, messageFiles.id);

  const now = Date.now();
  return rows.map((row) => {
    const stale = row.state === "copying" && isStaleCopying(row.updatedAt, now);
    return {
      messageId: row.messageId,
      path: row.path,
      state: stale ? "missing" : row.state,
      reason: stale ? "copy_failed" : row.reason,
      mediaId: row.mediaId,
      contentType: row.contentType,
      name: row.name ?? fileNameForPath(row.path),
      sizeBytes: row.sizeBytes,
    };
  });
}
