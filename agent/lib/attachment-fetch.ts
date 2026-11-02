/**
 * Выдача загруженного файла агенту (#9): канал eve вызывает `fetchFile` для
 * адреса `<APP_URL>/api/media/<uuid>` и получает байты из S3.
 *
 * Чужой адрес eve сам не скачивает: для любого неизвестного адреса и для
 * нарушений ниже бросается `attachmentError` с русским текстом, который
 * увидит модель. Строки `media` без объекта и с другим размером — тоже отказ.
 */
import { attachmentError, type FetchFileContext } from "eve/channels";
import { eq } from "drizzle-orm";

import { loadConfig } from "@/lib/config";
import { getDb } from "@/lib/db/client";
import { media } from "@/lib/db/schema";
import { mediaIdFromAppMediaUrl } from "@/lib/media/media-url";
import { getStorage } from "@/lib/s3";

export const ATTACHMENT_UNAVAILABLE =
  "Файл недоступен. Попросите пользователя прикрепить его заново.";
export const ATTACHMENT_NOT_UPLOADED =
  "Файл не был загружен до конца. Попросите пользователя прикрепить его заново.";
export const ATTACHMENT_SIZE_MISMATCH =
  "Размер файла не совпал с заявленным или превышает предел.";
export const ATTACHMENT_NO_USER =
  "Не удалось определить пользователя. Обновите страницу и повторите.";

export async function fetchUserAttachment(
  url: string,
  context?: FetchFileContext,
): Promise<{ bytes: Buffer; mediaType: string; filename: string }> {
  const current = context?.session.auth.current ?? null;
  if (current === null) throw attachmentError(ATTACHMENT_NO_USER);

  const config = loadConfig();
  const mediaId = mediaIdFromAppMediaUrl(url, config.appUrl);
  if (mediaId === null) throw attachmentError(ATTACHMENT_UNAVAILABLE);

  const [record] = await getDb()
    .select()
    .from(media)
    .where(eq(media.id, mediaId))
    .limit(1);
  if (
    record === undefined ||
    record.userId !== current.principalId ||
    record.kind !== "upload"
  ) {
    throw attachmentError(ATTACHMENT_UNAVAILABLE);
  }

  const storage = getStorage();
  const size = await storage.objectSize(record.objectKey);
  if (size === null) throw attachmentError(ATTACHMENT_NOT_UPLOADED);
  if (size !== record.sizeBytes || size > config.uploadMaxBytes) {
    throw attachmentError(ATTACHMENT_SIZE_MISMATCH);
  }

  const bytes = await storage.getObject(record.objectKey);
  return {
    // Без копии: у процесса eve и так пик в несколько размеров файла.
    bytes: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    mediaType: record.contentType,
    filename: record.originalName,
  };
}
