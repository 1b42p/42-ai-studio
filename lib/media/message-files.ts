import { and, asc, eq, isNull, lte, min, or, sql } from "drizzle-orm";
import type { SandboxSession } from "eve/sandbox";

import { getDb, getLockSqlClient } from "@/lib/db/client";
import { appSessions, media, messageFiles, type MessageFileReason } from "@/lib/db/schema";
import { getStorage, type Storage } from "@/lib/s3";
import { findAppSessionById } from "@/lib/sessions/service";
import { sleep } from "@/lib/sleep";

import { copySandboxFile, MediaCopyError, type CopiedSandboxFile } from "./copy";
import { contentTypeForPath, fileNameForPath, MAX_MESSAGE_LINKS } from "./files";
import { mediaObjectKey } from "./keys";
import { MediaSessionGoneError, requireLiveMediaSession, withLiveMediaSession } from "./live-session";
import { messageFileId, messageIdOf } from "./message-id";
import { parseSandboxLinks, type SandboxLink } from "./sandbox-path";

interface MessagePublication {
  appSessionId: string;
  messageId: string;
}

export interface CaptureMessageFilesOptions extends MessagePublication {
  links: readonly SandboxLink[];
  maxBytes: number;
  userId?: string;
  storage?: Storage;
  /** Уже опубликованные файлы и отклонённые ссылки песочницу не открывают. */
  getSandbox: () => Promise<SandboxSession>;
}

type PendingFile = { id: string; sandboxPath: string; createdAt: Date };

class MessageFileGoneError extends Error {}

const RETRY_SPACING_MS = 60_000;
const PENDING_LIMIT_MS = 24 * 60 * 60 * 1000;

function messageScope(appSessionId: string, messageId: string) {
  return and(eq(messageFiles.appSessionId, appSessionId), eq(messageFiles.messageId, messageId));
}

export function completedMessageFiles(data: { turnId?: string; stepIndex?: number; message?: string }) {
  const stepId = messageIdOf(data.turnId, data.stepIndex);
  if (stepId === undefined || !data.message) return null;
  const links = parseSandboxLinks(data.message);
  return links.length === 0 ? null : { messageId: messageFileId(stepId, data.message), links };
}

/** Вызывающий держит блокировку живой сессии; синхронизатор журнала тоже. */
export async function recordMessageFiles(
  tx: Parameters<Parameters<typeof withLiveMediaSession>[1]>[0],
  { appSessionId, messageId, links }: MessagePublication & { links: readonly SandboxLink[] },
): Promise<void> {
  const states = await tx.select({
    sandboxPath: messageFiles.sandboxPath,
    reason: messageFiles.reason,
  }).from(messageFiles).where(messageScope(appSessionId, messageId));

  const seen = new Set(states.map((row) => row.sandboxPath));
  let room = MAX_MESSAGE_LINKS - states.filter((row) => row.reason !== "too_many").length;
  const added = links.flatMap((link) => {
    const sandboxPath = link.path.replaceAll("\0", "");
    // Составной B-tree индекс имеет предел размера ключа. Недопустимо,
    // чтобы длинный Markdown-путь блокировал запись всей истории сессии.
    if (Buffer.byteLength(sandboxPath, "utf8") > 2048 || seen.has(sandboxPath)) return [];
    seen.add(sandboxPath);
    const reason: MessageFileReason | null =
      room-- <= 0 ? "too_many" : link.kind === "rejected" ? link.reason : null;
    return [{
      appSessionId, messageId, sandboxPath,
      state: reason === null ? "copying" as const : "missing" as const,
      reason,
    }];
  });
  if (added.length > 0) await tx.insert(messageFiles).values(added);
}

function pendingFiles({ appSessionId, messageId }: MessagePublication, due?: Date) {
  return getDb().select({
    id: messageFiles.id, sandboxPath: messageFiles.sandboxPath, createdAt: messageFiles.createdAt,
  })
    .from(messageFiles)
    .where(and(messageScope(appSessionId, messageId), eq(messageFiles.state, "copying"),
      due ? lte(messageFiles.updatedAt, due) : undefined));
}

export async function pendingMessageIdsForStep(appSessionId: string, stepId: string): Promise<string[]> {
  const rows = await getDb().selectDistinct({ messageId: messageFiles.messageId }).from(messageFiles)
    .where(and(eq(messageFiles.appSessionId, appSessionId), eq(messageFiles.state, "copying"),
      or(eq(messageFiles.messageId, stepId), sql`starts_with(${messageFiles.messageId}, ${`${stepId}:`})`)));
  return rows.map((row) => row.messageId);
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
async function withPublicationLock<T>(
  options: MessagePublication, run: () => Promise<T>, wait = true,
): Promise<T | undefined> {
  const operation = `${options.appSessionId}:${options.messageId}`;
  const lock = await getLockSqlClient().reserve();
  let locked = false;
  try {
    if (wait) {
      await lock`select pg_advisory_lock(5, hashtext(${operation}::text))`;
      locked = true;
    } else {
      const [claim] = await lock<{ locked: boolean }[]>`
        select pg_try_advisory_lock(5, hashtext(${operation}::text)) as locked`;
      locked = claim?.locked === true;
    }
    if (!locked) return;
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
  return (await withPublicationLock(options, async () => {
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
  })) ?? false;
}

function storedFile(storage: Storage, objectKey: string, originalName: string, signal?: AbortSignal) {
  return storage.objectInfo(objectKey, signal).then((object): CopiedSandboxFile | null => object && ({
    objectKey, originalName, sizeBytes: object.size,
    contentType: object.contentType ?? contentTypeForPath(originalName),
  }));
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
  const existingObject = () => storedFile(storage, objectKey, originalName);
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
        if (reason !== "copy_failed") {
          result = reason;
        } else {
          // Потерянный ответ PUT может скрывать уже сохранённый снимок.
          // Если объекта ещё нет, оставляем copying и повторяем в том же шаге.
          result = await existingObject();
          if (result === null) throw error;
        }
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
  // Eve журналирует исключение хука, но не повторяет его. Пока песочница
  // относится к этому шагу, повторяем короткие сбои сами.
  for (const delay of [200, 1_000, null]) {
    try {
      await captureOnce(options);
      return;
    } catch (error) {
      if (error instanceof MediaSessionGoneError) return;
      if (delay === null) throw error;
      await sleep(delay);
    }
  }
}

async function captureOnce(options: CaptureMessageFilesOptions): Promise<void> {
  const session = await findAppSessionById(options.appSessionId);
  if (session === null || (options.userId !== undefined && options.userId !== session.userId)) return;

  if (options.links.length > 0) {
    await withLiveMediaSession(options.appSessionId, (tx) => recordMessageFiles(tx, options));
  }
  if ((await pendingFiles(options).limit(1)).length === 0) return;
  if (!(await publishPending(options, session.userId))) return;
  // Открытие песочницы может само занять соединение пула замков; не держим
  // замок публикации до получения готовой песочницы.
  const access: SandboxAccess = await options.getSandbox().then(
    (sandbox) => ({ sandbox }),
    (error: unknown) => ({ error }),
  );
  await publishPending(options, session.userId, access);
}

/**
 * Завершает операции с уже выгруженными байтами независимо от хода Eve.
 * Исторический путь в песочнице мог быть перезаписан. Никакого нового PUT
 * здесь нет: только проверка стабильного ключа и конечный статус по сроку.
 */
export async function reconcileMessageFiles(storage = getStorage()): Promise<void> {
  const now = new Date();
  const due = new Date(now.getTime() - RETRY_SPACING_MS);
  const groups = await getDb().select({
    appSessionId: messageFiles.appSessionId, messageId: messageFiles.messageId,
    ownerId: appSessions.userId,
  }).from(messageFiles)
    .innerJoin(appSessions, eq(appSessions.id, messageFiles.appSessionId))
    .where(and(eq(messageFiles.state, "copying"), isNull(appSessions.deletedAt), lte(messageFiles.updatedAt, due)))
    .groupBy(messageFiles.appSessionId, messageFiles.messageId, appSessions.userId)
    .orderBy(asc(min(messageFiles.updatedAt)), asc(messageFiles.appSessionId), asc(messageFiles.messageId))
    .limit(20);

  for (const group of groups) {
    try {
      await withPublicationLock(group, async () => {
        const outcomes = await Promise.allSettled((await pendingFiles(group, due)).map(async (row) => {
          const originalName = fileNameForPath(row.sandboxPath);
          const objectKey = mediaObjectKey({
            appSessionId: group.appSessionId, userId: group.ownerId,
            kind: "message_file", name: originalName, objectId: row.id,
          });
          const expired = now.getTime() - row.createdAt.getTime() >= PENDING_LIMIT_MS;
          try {
            await requireLiveMediaSession(group.appSessionId);
            // Ошибка HEAD не доказывает отсутствие снимка даже после срока.
            const file = await storedFile(storage, objectKey, originalName, AbortSignal.timeout(5_000))
              .catch(() => undefined);
            if (file || (expired && file === null)) {
              await finishFile(group.appSessionId, group.ownerId, row.id, file ?? "copy_failed");
            } else {
              await withLiveMediaSession(group.appSessionId, async (tx) => {
                await tx.update(messageFiles).set({ updatedAt: now }).where(eq(messageFiles.id, row.id));
              });
            }
          } catch (error) {
            if (!(error instanceof MediaSessionGoneError || error instanceof MessageFileGoneError)) throw error;
            await storage.deleteObject(objectKey);
          }
        }));
        if (outcomes.some((outcome) => outcome.status === "rejected")) throw new Error("publication_reconcile_failed");
      }, false);
    } catch {
      console.warn("[media] publication_reconcile_failed");
    }
  }
}
