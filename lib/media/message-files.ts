import { and, eq } from "drizzle-orm";
import type { SandboxSession } from "eve/sandbox";

import { getDb, getLockSqlClient } from "@/lib/db/client";
import { media, messageFiles, type MessageFileReason } from "@/lib/db/schema";
import { getStorage, type Storage } from "@/lib/s3";
import { findAppSessionById } from "@/lib/sessions/service";

import { copySandboxFile, MediaCopyError, type CopiedSandboxFile } from "./copy";
import { contentTypeForPath, fileNameForPath, MAX_MESSAGE_LINKS } from "./files";
import { mediaObjectKey } from "./keys";
import { MediaSessionGoneError, requireLiveMediaSession, withLiveMediaSession } from "./live-session";
import type { SandboxLink } from "./sandbox-path";

export interface CaptureMessageFilesOptions {
  appSessionId: string;
  /** `<turnId>:<stepIndex>` из данных события `message.completed`. */
  messageId: string;
  links: readonly SandboxLink[];
  maxBytes: number;
  userId?: string;
  storage?: Storage;
  /** Уже опубликованные файлы и отклонённые ссылки песочницу не открывают. */
  getSandbox: () => Promise<SandboxSession>;
}

type PendingFile = { id: string; sandboxPath: string };

class MessageFileGoneError extends Error {}

function messageScope(appSessionId: string, messageId: string) {
  return and(eq(messageFiles.appSessionId, appSessionId), eq(messageFiles.messageId, messageId));
}

/**
 * Сохраняем все ссылки до первого I/O. Повтор того же шага подбирает все
 * незавершённые строки, даже если модель повторно написала другой текст.
 */
async function queueFiles(options: CaptureMessageFilesOptions): Promise<void> {
  const { appSessionId, messageId, links } = options;
  await withLiveMediaSession(appSessionId, async (tx) => {
    const states = await tx.select({
      sandboxPath: messageFiles.sandboxPath,
      reason: messageFiles.reason,
    }).from(messageFiles).where(messageScope(appSessionId, messageId));

    const seen = new Set(states.map((row) => row.sandboxPath));
    let room = MAX_MESSAGE_LINKS - states.filter((row) => row.reason !== "too_many").length;
    const added = links.flatMap((link) => {
      if (seen.has(link.path)) return [];
      seen.add(link.path);
      const reason: MessageFileReason | null =
        room-- <= 0 ? "too_many" : link.kind === "rejected" ? link.reason : null;
      return [{
        appSessionId, messageId, sandboxPath: link.path,
        state: reason === null ? "copying" as const : "missing" as const,
        reason,
      }];
    });
    if (added.length > 0) await tx.insert(messageFiles).values(added);
  });
}

function pendingFiles({ appSessionId, messageId }: CaptureMessageFilesOptions) {
  return getDb().select({ id: messageFiles.id, sandboxPath: messageFiles.sandboxPath })
    .from(messageFiles)
    .where(and(messageScope(appSessionId, messageId), eq(messageFiles.state, "copying")));
}

async function finishFile(appSessionId: string, ownerId: string, id: string, result: CopiedSandboxFile | MessageFileReason) {
  await withLiveMediaSession(appSessionId, async (tx) => {
    if (typeof result === "string") {
      await tx.update(messageFiles).set({ state: "missing", reason: result, updatedAt: new Date() })
        .where(eq(messageFiles.id, id));
      return;
    }
    const [created] = await tx.insert(media).values({
      ...result, userId: ownerId, appSessionId, kind: "message_file",
    }).returning({ id: media.id });
    if (created === undefined) throw new Error("Строка media не создана");
    const [linked] = await tx.update(messageFiles)
      .set({ state: "ready", reason: null, mediaId: created.id, updatedAt: new Date() })
      .where(eq(messageFiles.id, id))
      .returning({ id: messageFiles.id });
    if (linked === undefined) throw new MessageFileGoneError();
  });
}

/** Один писатель на сообщение. Блокировка освобождается при смерти процесса. */
async function withPublicationLock<T>(options: CaptureMessageFilesOptions, run: () => Promise<T>): Promise<T> {
  const operation = `${options.appSessionId}:${options.messageId}`;
  const lock = await getLockSqlClient().reserve();
  let locked = false;
  try {
    await lock`select pg_advisory_lock(5, hashtext(${operation}::text))`;
    locked = true;
    return await run();
  } finally {
    try {
      if (locked) {
        await lock`select pg_advisory_unlock(5, hashtext(${operation}::text))`;
      }
    } finally {
      lock.release();
    }
  }
}

type SandboxAccess = { sandbox: SandboxSession } | { error: unknown };

async function publishPending(
  options: CaptureMessageFilesOptions,
  ownerId: string,
  access?: SandboxAccess,
): Promise<boolean> {
  return withPublicationLock(options, async () => {
    // Другой исполнитель мог закончить публикацию, пока мы ждали замок
    // или открывали песочницу. Список перечитывается под замком.
    const pending = await pendingFiles(options);
    const outcomes = await Promise.allSettled(
      pending.map((row) => publishFile(options, ownerId, row, access)),
    );
    // Не отпускаем замок, пока работают остальные файлы этого сообщения.
    for (const outcome of outcomes) {
      if (outcome.status === "rejected") throw outcome.reason;
    }
    return outcomes.some((outcome) => outcome.status === "fulfilled" && outcome.value === "needs-sandbox");
  });
}

async function publishFile(
  options: CaptureMessageFilesOptions,
  ownerId: string,
  row: PendingFile,
  access?: SandboxAccess,
): Promise<"needs-sandbox" | void> {
  const { appSessionId, maxBytes } = options;
  const storage = options.storage ?? getStorage();
  const originalName = fileNameForPath(row.sandboxPath);
  const objectKey = mediaObjectKey({
    appSessionId, userId: ownerId, kind: "message_file", name: originalName, objectId: row.id,
  });
  const existingObject = async (): Promise<CopiedSandboxFile | null> => {
    const object = await storage.objectInfo(objectKey);
    if (object === null) return null;
    return {
      objectKey, originalName, sizeBytes: object.size,
      contentType: object.contentType ?? contentTypeForPath(originalName),
    };
  };
  try {
    await requireLiveMediaSession(appSessionId);
    // Сбой после завершения PUT, но до коммита SQL: принимаем ровно тот же
    // объект, не читая песочницу (файл там мог уже измениться или исчезнуть).
    let result: CopiedSandboxFile | MessageFileReason | null = await existingObject();
    if (result === null && access === undefined) return "needs-sandbox";
    if (result === null && access !== undefined) {
      try {
        if ("error" in access) throw access.error;
        result = await copySandboxFile({
          sandbox: access.sandbox, path: row.sandboxPath, appSessionId,
          userId: ownerId, maxBytes, storage, objectId: row.id,
        });
      } catch (error) {
        if (error instanceof MediaSessionGoneError) throw error;
        const reason = error instanceof MediaCopyError ? error.reason : "copy_failed";
        // Если ответ PUT потерялся, не затираем уже сохранённый объект.
        result = reason === "copy_failed" ? await existingObject() ?? reason : reason;
      }
    }
    if (result !== null) await finishFile(appSessionId, ownerId, row.id, result);
  } catch (error) {
    // Если DELETE очистил префикс раньше завершения PUT, удаляем поздний
    // объект. Ошибка БД сама по себе объект не стирает: коммит мог состояться.
    if (!(error instanceof MediaSessionGoneError || error instanceof MessageFileGoneError)) throw error;
    await storage.deleteObject(objectKey);
  }
}

/** Вызывается внутри шага Eve; возврат хука означает конец публикации. */
export async function captureMessageFiles(options: CaptureMessageFilesOptions): Promise<void> {
  const session = await findAppSessionById(options.appSessionId);
  if (session === null || (options.userId !== undefined && options.userId !== session.userId)) return;

  try {
    if (options.links.length > 0) await queueFiles(options);
    if ((await pendingFiles(options).limit(1)).length === 0) return;
    if (!(await publishPending(options, session.userId))) return;
    // Открытие песочницы может само занять соединение пула замков; не держим
    // замок публикации до получения готовой песочницы.
    const access: SandboxAccess = await options.getSandbox().then(
      (sandbox) => ({ sandbox }),
      (error: unknown) => ({ error }),
    );
    await publishPending(options, session.userId, access);
  } catch (error) {
    if (!(error instanceof MediaSessionGoneError)) throw error;
  }
}
