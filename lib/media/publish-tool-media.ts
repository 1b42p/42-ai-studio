/**
 * Медиа вызова инструмента (#8): серверные инструменты показывают файл из
 * песочницы в карточке вызова. Идемпотентно по паре «вызов, путь», поэтому
 * повторный шаг с тем же `callId` вторую строку не создаёт.
 *
 * Модуль общий: его вызывают инструменты через `@/lib/media/publish-tool-media`.
 */
import { and, eq } from "drizzle-orm";
import type { SandboxSession } from "eve/sandbox";

import { loadConfig } from "@/lib/config";
import { getDb } from "@/lib/db/client";
import { media, toolCallMedia } from "@/lib/db/schema";
import { getStorage, type Storage } from "@/lib/s3";
import { findAppSessionByEveId } from "@/lib/sessions/service";

import { copySandboxFile, MediaCopyError, type MediaCopyReason } from "./copy";
import { resolveSandboxFilePath } from "./sandbox-path";

export type ToolMediaKind = "tool_media" | "preview";
export type PublishToolMediaReason = "no_session" | MediaCopyReason;

/** Ошибка публикации медиа: решение, что делать, принимает инструмент. */
export class PublishToolMediaError extends Error {
  readonly reason: PublishToolMediaReason;

  constructor(reason: PublishToolMediaReason, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PublishToolMediaError";
    this.reason = reason;
  }
}

/** Часть контекста инструмента, которая нужна публикации. */
export interface PublishToolMediaContext {
  readonly session: {
    readonly id: string;
    readonly parent?: { readonly rootSessionId: string };
  };
  readonly callId: string;
  getSandbox(): Promise<SandboxSession>;
}

export interface PublishToolMediaOptions {
  readonly path: string;
  readonly contentType?: string;
  readonly kind?: ToolMediaKind;
  /** Только серверный снимок байтов после проверки формата и размера. */
  readonly validatedBytes?: Uint8Array;
}

export interface PublishToolMediaDependencies {
  readonly storage?: Storage;
  readonly maxBytes?: number;
}

async function existingMediaId(
  appSessionId: string,
  callId: string,
  sandboxPath: string,
): Promise<string | null> {
  const [row] = await getDb()
    .select({ mediaId: toolCallMedia.mediaId })
    .from(toolCallMedia)
    .where(
      and(
        eq(toolCallMedia.appSessionId, appSessionId),
        eq(toolCallMedia.callId, callId),
        eq(toolCallMedia.sandboxPath, sandboxPath),
      ),
    )
    .limit(1);
  return row?.mediaId ?? null;
}

/**
 * Копирует файл из песочницы в S3 и связывает его с вызовом инструмента.
 * Возвращает идентификатор медиа; ошибки — `PublishToolMediaError`.
 */
export async function publishToolMedia(
  ctx: PublishToolMediaContext,
  options: PublishToolMediaOptions,
  dependencies: PublishToolMediaDependencies = {},
): Promise<{ mediaId: string }> {
  const eveSessionId = ctx.session.parent?.rootSessionId ?? ctx.session.id;
  const session = await findAppSessionByEveId(eveSessionId);
  if (session === null) throw new PublishToolMediaError("no_session", "Сессия не найдена");

  const path = resolveSandboxFilePath(options.path);
  if (path.kind !== "file") {
    throw new PublishToolMediaError("outside_workspace", "Путь вне рабочей области");
  }

  const kind = options.kind ?? "tool_media";
  const previous = await existingMediaId(session.id, ctx.callId, path.path);
  if (previous !== null) return { mediaId: previous };

  let copied;
  try {
    copied = await copySandboxFile({
      sandbox: await ctx.getSandbox(),
      path: path.path,
      maxBytes: dependencies.maxBytes ?? loadConfig().mediaCopyMaxBytes,
      userId: session.userId,
      appSessionId: session.id,
      kind,
      contentType: options.contentType,
      storage: dependencies.storage,
      validatedBytes: options.validatedBytes,
    });
  } catch (error) {
    if (error instanceof MediaCopyError) {
      throw new PublishToolMediaError(error.reason, error.message, { cause: error });
    }
    throw new PublishToolMediaError("copy_failed", "Не удалось сохранить файл", {
      cause: error,
    });
  }

  const db = getDb();
  const [created] = await db
    .insert(media)
    .values({
      userId: session.userId,
      appSessionId: session.id,
      kind,
      objectKey: copied.objectKey,
      contentType: copied.contentType,
      sizeBytes: copied.sizeBytes,
      originalName: copied.originalName,
    })
    .returning({ id: media.id });
  if (created === undefined) {
    throw new PublishToolMediaError("copy_failed", "Строка media не создана");
  }

  const [linked] = await db
    .insert(toolCallMedia)
    .values({
      appSessionId: session.id,
      callId: ctx.callId,
      sandboxPath: path.path,
      mediaId: created.id,
    })
    .onConflictDoNothing()
    .returning({ mediaId: toolCallMedia.mediaId });

  if (linked !== undefined) return { mediaId: linked.mediaId };

  // Параллельный повтор шага успел первым: оставляем одну строку media
  // и не оставляем второй объект в S3.
  const winner = await existingMediaId(session.id, ctx.callId, path.path);
  await db.delete(media).where(eq(media.id, created.id));
  await (dependencies.storage ?? getStorage()).deleteObject(copied.objectKey).catch(() => undefined);
  if (winner === null) {
    throw new PublishToolMediaError("copy_failed", "Связь с вызовом не создана");
  }
  return { mediaId: winner };
}
