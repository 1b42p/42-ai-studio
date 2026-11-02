/**
 * Файлы, на которые агент сослался в сообщении (#8): идемпотентная запись
 * строк `message_files` и копирование в S3.
 *
 * Хук может сработать повторно (доставка «хотя бы раз»), поэтому повторная
 * строка не создаётся, готовая или отсутствующая не пересчитывается, а
 * зависшая `copying` старше 15 минут перезапускается.
 */
import { and, eq, lt } from "drizzle-orm";
import type { SandboxSession } from "eve/sandbox";

import { getDb } from "@/lib/db/client";
import {
  appSessions,
  media,
  messageFiles,
  type MessageFileReason,
} from "@/lib/db/schema";

import { copySandboxFile, MediaCopyError } from "./copy";
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
  const db = getDb();
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
    .where(whereRow(appSessionId, messageId, sandboxPath))
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
}

async function markMissing(id: string, reason: MessageFileReason): Promise<void> {
  await getDb()
    .update(messageFiles)
    .set({ state: "missing", reason, mediaId: null, updatedAt: new Date() })
    .where(eq(messageFiles.id, id));
}

/**
 * Сохраняет файлы сообщения. Промис завершается, когда все ссылки обработаны;
 * вызывающий сам решает, ждать его целиком или ограничить время.
 */
export async function captureMessageFiles(options: CaptureMessageFilesOptions): Promise<void> {
  const db = getDb();
  let userId = options.userId;
  if (userId === undefined) {
    const [session] = await db
      .select({ userId: appSessions.userId })
      .from(appSessions)
      .where(eq(appSessions.id, options.appSessionId))
      .limit(1);
    if (session === undefined) return;
    userId = session.userId;
  }
  if (userId === undefined) return;
  const ownerId: string = userId;

  // Несколько текстовых блоков одного шага делят `message_id` и один предел
  // в 20 ссылок: уже записанные строки тоже считаются.
  const existing = await db
    .select({
      path: messageFiles.sandboxPath,
      state: messageFiles.state,
      updatedAt: messageFiles.updatedAt,
    })
    .from(messageFiles)
    .where(
      and(
        eq(messageFiles.appSessionId, options.appSessionId),
        eq(messageFiles.messageId, options.messageId),
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
    await db
      .insert(messageFiles)
      .values({
        appSessionId: options.appSessionId,
        messageId: options.messageId,
        sandboxPath: link.path,
        state: "missing",
        reason: "too_many",
      })
      .onConflictDoNothing();
  }

  let sandboxPromise: Promise<SandboxSession> | undefined;
  const getSandbox = () => (sandboxPromise ??= options.getSandbox());

  await Promise.all(
    accepted.map(async (link) => {
      const rowId = await claimRow(options.appSessionId, options.messageId, link.path);
      if (rowId === null) return;

      if (link.kind === "rejected") {
        await markMissing(rowId, link.reason);
        return;
      }

      try {
        const sandbox = await getSandbox();
        const copied = await copySandboxFile({
          sandbox,
          path: link.path,
          maxBytes: options.maxBytes,
          userId: ownerId,
          appSessionId: options.appSessionId,
          kind: "message_file",
        });
        const [created] = await db
          .insert(media)
          .values({
            userId: ownerId,
            appSessionId: options.appSessionId,
            kind: "message_file",
            objectKey: copied.objectKey,
            contentType: copied.contentType,
            sizeBytes: copied.sizeBytes,
            originalName: copied.originalName,
          })
          .returning({ id: media.id });
        if (created === undefined) throw new Error("Строка media не создана");
        await db
          .update(messageFiles)
          .set({ state: "ready", reason: null, mediaId: created.id, updatedAt: new Date() })
          .where(eq(messageFiles.id, rowId));
      } catch (error) {
        const reason = error instanceof MediaCopyError ? error.reason : "copy_failed";
        if (!(error instanceof MediaCopyError)) {
          console.error("[media] файл ответа не сохранён", {
            appSessionId: options.appSessionId,
            messageId: options.messageId,
            error,
          });
        }
        await markMissing(rowId, reason);
      }
    }),
  );
}
