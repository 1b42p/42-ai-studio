/** Чтение медиа и файлов сообщений для HTTP-маршрутов (#8). */
import { and, eq, isNull } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import { appSessions, media, messageFiles, toolCallMedia, type Media } from "@/lib/db/schema";

import { draftExportFileGroup } from "./draft-export";
import { fileNameForPath, isStaleCopying } from "./files";
import type { MessageFileView } from "./types";

/** Медиа пользователя; чужое и несуществующее неразличимы. */
export async function findMediaForUser(id: string, userId: string): Promise<Media | null> {
  const [record] = await getDb()
    .select({ media })
    .from(media)
    .innerJoin(appSessions, eq(appSessions.id, media.appSessionId))
    .where(and(eq(media.id, id), eq(media.userId, userId), isNull(appSessions.deletedAt)))
    .limit(1);
  return record?.media ?? null;
}

/**
 * Все файлы сессии по сообщениям. Зависшая `copying` старше 15 минут
 * показывается как `missing`/`copy_failed`: копирование уже не идёт.
 */
export async function listSessionFiles(appSessionId: string): Promise<MessageFileView[]> {
  const db = getDb();
  const [rows, exported] = await Promise.all([db
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
    .innerJoin(appSessions, eq(appSessions.id, messageFiles.appSessionId))
    .leftJoin(media, eq(media.id, messageFiles.mediaId))
    .where(and(eq(messageFiles.appSessionId, appSessionId), isNull(appSessions.deletedAt)))
    .orderBy(messageFiles.createdAt, messageFiles.id),
  db
    .select({
      callId: toolCallMedia.callId,
      path: toolCallMedia.sandboxPath,
      mediaId: media.id,
      contentType: media.contentType,
      name: media.originalName,
      sizeBytes: media.sizeBytes,
    })
    .from(toolCallMedia)
    .innerJoin(appSessions, eq(appSessions.id, toolCallMedia.appSessionId))
    .innerJoin(media, eq(media.id, toolCallMedia.mediaId))
    .where(and(eq(toolCallMedia.appSessionId, appSessionId), isNull(appSessions.deletedAt), eq(media.contentType, "video/mp4"))),
  ]);

  const now = Date.now();
  const attachments: MessageFileView[] = rows.map((row) => {
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
  for (const { callId, ...file } of exported) {
    attachments.push({ ...file, messageId: draftExportFileGroup(callId), state: "ready", reason: null });
  }
  return attachments;
}
