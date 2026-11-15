/**
 * Файлы, на которые агент сослался в сообщении (#8): идемпотентная запись
 * строк `message_files` и копирование в S3.
 *
 * Хук может сработать повторно (доставка «хотя бы раз»), поэтому повторная
 * строка не создаётся, готовая или отсутствующая не пересчитывается, а
 * зависшая `copying` старше 15 минут перезапускается.
 */
import { and, eq, isNull, lt } from "drizzle-orm";
import type { SandboxSession } from "eve/sandbox";

import { getDb } from "@/lib/db/client";
import {
  appSessions,
  media,
  messageFiles,
  type MessageFileReason,
} from "@/lib/db/schema";
import { getStorage, type Storage } from "@/lib/s3";
import { findAppSessionById } from "@/lib/sessions/service";

import { copySandboxFile, MediaCopyError, type CopiedSandboxFile } from "./copy";
import { MediaSessionGoneError, withLiveMediaSession } from "./live-session";
import { COPYING_STALE_MS, isStaleCopying, MAX_MESSAGE_LINKS } from "./files";
import type { SandboxLink } from "./sandbox-path";

export interface CaptureMessageFilesOptions {
  appSessionId: string;
  /** `<turnId>:<stepIndex>` из данных события `message.completed`. */
  messageId: string;
  links: readonly SandboxLink[];
  maxBytes: number;
  /** Владелец сессии, если вызывающий уже прочитал его из `app_sessions`. */
  userId?: string;
  /** Подмена хранилища в тестах отказа S3. */
  storage?: Storage;
  /** Лениво открывает песочницу сессии: без файлов её не трогаем. */
  getSandbox: () => Promise<SandboxSession>;
}

function whereRow(appSessionId: string, messageId: string, sandboxPath: string) {
  return and(
    eq(messageFiles.appSessionId, appSessionId),
    eq(messageFiles.messageId, messageId),
    eq(messageFiles.sandboxPath, sandboxPath),
  );
}

/**
 * Вставляет строку в `copying` или забирает зависшую. `null` — строка уже
 * обработана или её копирование идёт прямо сейчас.
 */
async function claimRow(
  appSessionId: string,
  messageId: string,
  sandboxPath: string,
): Promise<string | null> {
  try {
    return await withLiveMediaSession(appSessionId, async (db) => {
      const [inserted] = await db
        .insert(messageFiles)
        .values({ appSessionId, messageId, sandboxPath, state: "copying" })
        .onConflictDoNothing()
        .returning({ id: messageFiles.id });
      if (inserted !== undefined) return inserted.id;

      const staleBefore = new Date(Date.now() - COPYING_STALE_MS);
      const [existing] = await db
        .select({ id: messageFiles.id, state: messageFiles.state, updatedAt: messageFiles.updatedAt })
        .from(messageFiles)
        .innerJoin(appSessions, eq(appSessions.id, messageFiles.appSessionId))
        .where(and(whereRow(appSessionId, messageId, sandboxPath), isNull(appSessions.deletedAt)))
        .limit(1);
      if (existing === undefined || existing.state !== "copying") return null;
      if (!isStaleCopying(existing.updatedAt)) return null;

      const [claimed] = await db
        .update(messageFiles)
        .set({ updatedAt: new Date() })
        .where(
          and(
            eq(messageFiles.id, existing.id),
            eq(messageFiles.state, "copying"),
            lt(messageFiles.updatedAt, staleBefore),
          ),
        )
        .returning({ id: messageFiles.id });
      return claimed?.id ?? null;
    });
  } catch (error) {
    if (error instanceof MediaSessionGoneError) return null;
    throw error;
  }
}

async function markMissing(
  appSessionId: string,
  id: string,
  reason: MessageFileReason,
): Promise<void> {
  try {
    await withLiveMediaSession(appSessionId, async (tx) =>
      tx.update(messageFiles)
        .set({ state: "missing", reason, mediaId: null, updatedAt: new Date() })
        .where(eq(messageFiles.id, id)),
    );
  } catch (error) {
    if (!(error instanceof MediaSessionGoneError)) throw error;
  }
}

/**
 * Сохраняет файлы сообщения. Промис завершается, когда все ссылки обработаны;
 * вызывающий сам решает, ждать его целиком или ограничить время.
 */
export async function captureMessageFiles(options: CaptureMessageFilesOptions): Promise<void> {
  const db = getDb();
  // Переданный владельцем кэш не заменяет проверку существования сессии.
  const session = await findAppSessionById(options.appSessionId);
  if (session === null) return;
  if (options.userId !== undefined && options.userId !== session.userId) return;
  const ownerId = session.userId;

  // Несколько текстовых блоков одного шага делят `message_id` и один предел
  // в 20 ссылок: уже записанные строки тоже считаются.
  const existing = await db
    .select({
      path: messageFiles.sandboxPath,
      state: messageFiles.state,
      updatedAt: messageFiles.updatedAt,
    })
    .from(messageFiles)
    .innerJoin(appSessions, eq(appSessions.id, messageFiles.appSessionId))
    .where(
      and(
        eq(messageFiles.appSessionId, options.appSessionId),
        eq(messageFiles.messageId, options.messageId),
        isNull(appSessions.deletedAt),
      ),
    );
  const now = Date.now();
  // Готовые и отсутствующие не пересчитываются; зависшая `copying` — да.
  const known = new Set(
    existing
      .filter((row) => row.state !== "copying" || !isStaleCopying(row.updatedAt, now))
      .map((row) => row.path),
  );
  const stale = new Set(
    existing
      .filter((row) => row.state === "copying" && isStaleCopying(row.updatedAt, now))
      .map((row) => row.path),
  );
  const retry = options.links.filter((link) => stale.has(link.path));
  const fresh = options.links.filter((link) => !known.has(link.path) && !stale.has(link.path));
  const room = Math.max(0, MAX_MESSAGE_LINKS - existing.length);
  const accepted = [...retry, ...fresh.slice(0, room)];
  const overflow = fresh.slice(room);
  for (const link of overflow) {
    try {
      await withLiveMediaSession(options.appSessionId, async (tx) =>
        tx.insert(messageFiles)
          .values({
            appSessionId: options.appSessionId,
            messageId: options.messageId,
            sandboxPath: link.path,
            state: "missing",
            reason: "too_many",
          })
          .onConflictDoNothing(),
      );
    } catch (error) {
      if (error instanceof MediaSessionGoneError) return;
      throw error;
    }
  }

  let sandboxPromise: Promise<SandboxSession> | undefined;
  const getSandbox = () => (sandboxPromise ??= options.getSandbox());

  await Promise.all(
    accepted.map(async (link) => {
      const rowId = await claimRow(options.appSessionId, options.messageId, link.path);
      if (rowId === null) return;

      if (link.kind === "rejected") {
        await markMissing(options.appSessionId, rowId, link.reason);
        return;
      }

      let copied: CopiedSandboxFile | undefined;
      try {
        const sandbox = await getSandbox();
        copied = await copySandboxFile({
          sandbox,
          path: link.path,
          maxBytes: options.maxBytes,
          userId: ownerId,
          appSessionId: options.appSessionId,
          kind: "message_file",
          storage: options.storage,
        });
        const file = copied;
        await withLiveMediaSession(options.appSessionId, async (tx) => {
          const [created] = await tx
            .insert(media)
            .values({
              userId: ownerId,
              appSessionId: options.appSessionId,
              kind: "message_file",
              objectKey: file.objectKey,
              contentType: file.contentType,
              sizeBytes: file.sizeBytes,
              originalName: file.originalName,
            })
            .returning({ id: media.id });
          if (created === undefined) throw new Error("Строка media не создана");
          const [linked] = await tx
            .update(messageFiles)
            .set({ state: "ready", reason: null, mediaId: created.id, updatedAt: new Date() })
            .where(eq(messageFiles.id, rowId))
            .returning({ id: messageFiles.id });
          if (linked === undefined) throw new Error("Строка файла сообщения исчезла");
        });
      } catch (error) {
        if (copied !== undefined) {
          await (options.storage ?? getStorage()).deleteObject(copied.objectKey);
        }
        if (error instanceof MediaSessionGoneError) return;
        const reason = error instanceof MediaCopyError ? error.reason : "copy_failed";
        if (!(error instanceof MediaCopyError)) {
          console.error("[media] файл ответа не сохранён", {
            appSessionId: options.appSessionId,
            messageId: options.messageId,
            error,
          });
        }
        await markMissing(options.appSessionId, rowId, reason);
      }
    }),
  );
}
