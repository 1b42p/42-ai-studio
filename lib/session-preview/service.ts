import { and, eq, sql } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import { appSessions, media, sessionPreviewCalls, toolCallMedia } from "@/lib/db/schema";
import { publishToolMedia, type PublishToolMediaContext } from "@/lib/media/publish-tool-media";
import { getStorage, type Storage } from "@/lib/s3";
import { findAppSessionByEveId } from "@/lib/sessions/service";

import { previewError } from "./errors";
import { readPreviewStream } from "./read";
import { PREVIEW_MAX_BYTES, previewContentType, previewPath, previewSizeAllowed } from "./validation";

export interface SessionPreviewResult {
  path: string;
  size: number;
  contentType: string;
}

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/** Сеть вне транзакции. Снятое превью больше никогда не назначается повтором шага. */
async function removeReplacedPreview(
  sessionId: string,
  userId: string,
  mediaId: string | null,
  storage: Storage,
): Promise<void> {
  if (mediaId === null) return;
  const [row] = await getDb().select({ objectKey: media.objectKey }).from(media)
    .innerJoin(appSessions, eq(appSessions.id, media.appSessionId))
    .where(and(
      eq(media.id, mediaId), eq(media.appSessionId, sessionId),
      eq(media.userId, userId), eq(media.kind, "preview"),
      // SQL NULL должен также означать «указатель не на этот объект».
      sql`${media.id} is distinct from ${appSessions.previewMediaId}`,
    ));
  if (row === undefined) return;
  await storage.deleteObject(row.objectKey).catch(() => undefined);
  await getDb().delete(media).where(and(
    eq(media.id, mediaId), eq(media.appSessionId, sessionId),
    eq(media.userId, userId), eq(media.kind, "preview"),
  ));
}

/**
 * Квитанция могла сохраниться до поздней публикации параллельного повтора.
 * После перезапуска проверяем и прежнее превью, и актуальную связь именно
 * этого вызова с файлом. removeReplacedPreview сохраняет текущее превью.
 */
async function cleanupCompletedCall(
  sessionId: string,
  userId: string,
  callId: string,
  path: string,
  replacedMediaId: string | null,
  storage: Storage,
): Promise<void> {
  await removeReplacedPreview(sessionId, userId, replacedMediaId, storage);
  const [linked] = await getDb().select({ mediaId: toolCallMedia.mediaId })
    .from(toolCallMedia).where(and(
      eq(toolCallMedia.appSessionId, sessionId),
      eq(toolCallMedia.callId, callId),
      eq(toolCallMedia.sandboxPath, path),
    ));
  if (linked !== undefined) {
    await removeReplacedPreview(sessionId, userId, linked.mediaId, storage);
  }
}

export async function setSessionPreview(
  ctx: PublishToolMediaContext,
  input: { path: string },
  dependencies: { storage?: Storage } = {},
): Promise<SessionPreviewResult> {
  const session = await findAppSessionByEveId(ctx.session.parent?.rootSessionId ?? ctx.session.id);
  if (session === null) throw previewError("preview_no_session");
  const path = previewPath(input.path);
  if (path === null) throw previewError("preview_bad_path", input.path);
  const db = getDb();
  const storage = dependencies.storage ?? getStorage();
  const identity = and(
    eq(sessionPreviewCalls.appSessionId, session.id),
    eq(sessionPreviewCalls.callId, ctx.callId), eq(sessionPreviewCalls.sandboxPath, path),
  );
  const [receipt] = await db.select().from(sessionPreviewCalls).where(identity);
  if (receipt !== undefined) {
    await cleanupCompletedCall(
      session.id, session.userId, ctx.callId, path, receipt.replacedMediaId, storage,
    );
    return receipt.result;
  }

  const sandbox = await ctx.getSandbox();
  const real = await sandbox.run({ command: `realpath -e -- ${quote(path)}` });
  if (real.exitCode !== 0) throw previewError("preview_not_found", input.path);
  const realPath = previewPath(real.stdout.replace(/\r?\n$/, ""));
  if (realPath === null) throw previewError("preview_bad_path", input.path);
  const regular = await sandbox.run({ command: `test -f ${quote(realPath)}` });
  if (regular.exitCode !== 0) throw previewError("preview_not_found", input.path);
  const stat = await sandbox.run({ command: `LC_ALL=C stat -c %s -- ${quote(realPath)}` });
  const size = Number(stat.stdout.trim());
  if (stat.exitCode !== 0 || !/^\d+$/.test(stat.stdout.trim()) || !Number.isSafeInteger(size)) {
    throw previewError("preview_not_found", input.path);
  }
  if (!previewSizeAllowed(size)) throw previewError("preview_too_large", input.path, size);
  const source = await sandbox.readFile({ path: realPath });
  if (source === null) throw previewError("preview_not_found", input.path);
  const bytes = await readPreviewStream(source, input.path);
  const contentType = previewContentType(bytes);
  if (contentType === null) throw previewError("preview_not_image", input.path);
  let published: { mediaId: string };
  try {
    published = await publishToolMedia(ctx, {
      path, kind: "preview", contentType, validatedBytes: bytes,
    }, { storage, maxBytes: PREVIEW_MAX_BYTES });
  } catch (error) {
    // Пока параллельный повтор связывал публикацию, следующий вызов мог
    // уже заменить и удалить её. Завершённая квитанция сильнее ошибки
    // исчезнувшей tool_call_media и не требует возвращать старую картинку.
    const [completed] = await db.select().from(sessionPreviewCalls).where(identity);
    if (completed === undefined) throw error;
    await cleanupCompletedCall(
      session.id, session.userId, ctx.callId, path, completed.replacedMediaId, storage,
    );
    return completed.result;
  }

  const committed = await db.transaction(async (tx) => {
    const [current] = await tx.select().from(appSessions)
      .where(and(eq(appSessions.id, session.id), eq(appSessions.userId, session.userId)))
      .for("update");
    if (current === undefined) throw previewError("preview_no_session");
    const [existing] = await tx.select().from(sessionPreviewCalls).where(identity);
    if (existing !== undefined) return existing;
    const [stored] = await tx.select().from(media).where(and(
      eq(media.id, published.mediaId), eq(media.userId, session.userId),
      eq(media.appSessionId, session.id), eq(media.kind, "preview"),
    ));
    if (stored === undefined) throw new Error("Не удалось сохранить превью сессии.");
    const result = { path: input.path, size: stored.sizeBytes, contentType: stored.contentType };
    const replacedMediaId = current.previewMediaId === published.mediaId ? null : current.previewMediaId;
    await tx.update(appSessions).set({ previewMediaId: published.mediaId })
      .where(eq(appSessions.id, session.id));
    const [created] = await tx.insert(sessionPreviewCalls).values({
      appSessionId: session.id, callId: ctx.callId, sandboxPath: path, result, replacedMediaId,
    }).returning();
    return created!;
  });
  await cleanupCompletedCall(
    session.id, session.userId, ctx.callId, path, committed.replacedMediaId, storage,
  );
  // Параллельный повтор мог начать публикацию до появления квитанции,
  // а закончить уже после следующей замены. Его лишняя копия не становится
  // текущей и также должна быть удалена.
  await removeReplacedPreview(session.id, session.userId, published.mediaId, storage);
  return committed.result;
}
