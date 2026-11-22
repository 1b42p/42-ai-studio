/** Чтение медиа и файлов сообщений для HTTP-маршрутов (#8). */
import { and, eq, isNull } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import { appSessions, media, messageFiles, type Media } from "@/lib/db/schema";

import { fileNameForPath } from "./files";
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

/** Только сохранённые статусы и метаданные, без I/O с песочницей. */
export async function listSessionFiles(appSessionId: string): Promise<MessageFileView[]> {
  const rows = await getDb()
    .select({
      messageId: messageFiles.messageId,
      path: messageFiles.sandboxPath,
      state: messageFiles.state,
      reason: messageFiles.reason,
      mediaId: messageFiles.mediaId,
      contentType: media.contentType,
      name: media.originalName,
      sizeBytes: media.sizeBytes,
    })
    .from(messageFiles)
    .innerJoin(appSessions, eq(appSessions.id, messageFiles.appSessionId))
    .leftJoin(media, eq(media.id, messageFiles.mediaId))
    .where(and(eq(messageFiles.appSessionId, appSessionId), isNull(appSessions.deletedAt)))
    .orderBy(messageFiles.createdAt, messageFiles.id);

  return rows.map((row) => ({ ...row, name: row.name ?? fileNameForPath(row.path) }));
}
