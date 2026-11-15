/** Короткий барьер публикации: удаление и запись строк медиа не пересекаются. */
import { and, eq, isNull } from "drizzle-orm";

import { getDb, type Database } from "@/lib/db/client";
import { appSessions } from "@/lib/db/schema";
import { findAppSessionById } from "@/lib/sessions/service";

type MediaTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

export class MediaSessionGoneError extends Error {
  constructor() {
    super("Сессия не найдена");
    this.name = "MediaSessionGoneError";
  }
}

export async function requireLiveMediaSession(appSessionId: string): Promise<void> {
  if ((await findAppSessionById(appSessionId)) === null) throw new MediaSessionGoneError();
}

/** Только SQL: не удерживать эту блокировку во время обращения к S3/песочнице. */
export async function withLiveMediaSession<T>(
  appSessionId: string,
  write: (tx: MediaTransaction) => Promise<T>,
): Promise<T> {
  return getDb().transaction(async (tx) => {
    const [session] = await tx
      .select({ id: appSessions.id })
      .from(appSessions)
      .where(and(eq(appSessions.id, appSessionId), isNull(appSessions.deletedAt)))
      .for("update");
    if (session === undefined) throw new MediaSessionGoneError();
    return write(tx);
  });
}
