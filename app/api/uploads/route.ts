/**
 * POST /api/uploads — строка `media` и подписанная ссылка на загрузку (#9).
 *
 * Браузер кладёт файл прямо в S3 по `uploadUrl`; через сервер приложения
 * проходят только поля. Ссылка живёт 15 минут, `Content-Type` входит в
 * подпись, поэтому другой заголовок хранилище отвергает.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { checkOrigin, requireApiUser } from "@/lib/auth/guard";
import { loadConfig } from "@/lib/config";
import { getDb } from "@/lib/db/client";
import { media } from "@/lib/db/schema";
import { errorResponse } from "@/lib/http/errors";
import { getStorage } from "@/lib/s3";
import { findAppSessionForUser } from "@/lib/sessions/service";
import { isUuid } from "@/lib/sessions/access";
import { uploadObjectKey } from "@/lib/uploads/keys";
import { formatUploadLimit, UPLOAD_URL_TTL_SECONDS } from "@/lib/uploads/limits";
import { uploadOriginalName } from "@/lib/uploads/name";
import { parseUploadRequest } from "@/lib/uploads/request";

export const dynamic = "force-dynamic";

const INVALID_REQUEST_MESSAGE = "Укажите имя, тип и размер файла.";
const SESSION_NOT_FOUND_MESSAGE = "Сессия не найдена.";

export async function POST(request: NextRequest): Promise<Response> {
  const user = await requireApiUser(request);
  if (user instanceof Response) return user;

  const config = loadConfig();
  const originError = checkOrigin(request, config.appUrl);
  if (originError !== null) return originError;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse(400, "invalid_request", INVALID_REQUEST_MESSAGE);
  }

  const parsed = parseUploadRequest(body, config.uploadMaxBytes);
  if (!parsed.ok) {
    if (parsed.kind === "too_large") {
      return errorResponse(
        413,
        "too_large",
        `Файл «${parsed.name}» больше допустимых ${formatUploadLimit(config.uploadMaxBytes)}.`,
      );
    }
    return errorResponse(400, "invalid_request", INVALID_REQUEST_MESSAGE);
  }

  const { appSessionId, name, contentType, sizeBytes } = parsed.value;
  if (!isUuid(appSessionId)) {
    return errorResponse(404, "not_found", SESSION_NOT_FOUND_MESSAGE);
  }
  const session = await findAppSessionForUser(appSessionId, user.id);
  if (session === null) return errorResponse(404, "not_found", SESSION_NOT_FOUND_MESSAGE);

  const id = randomUUID();
  const objectKey = uploadObjectKey({ userId: user.id, appSessionId, uploadId: id, name });
  const expiresAt = new Date(Date.now() + UPLOAD_URL_TTL_SECONDS * 1000).toISOString();
  const uploadUrl = await getStorage().presignUpload(objectKey, contentType, {
    expiresIn: UPLOAD_URL_TTL_SECONDS,
  });

  await getDb().insert(media).values({
    id,
    userId: user.id,
    appSessionId,
    kind: "upload",
    objectKey,
    contentType,
    sizeBytes,
    originalName: uploadOriginalName(name),
  });

  return Response.json(
    {
      id,
      uploadUrl,
      method: "PUT",
      headers: { "Content-Type": contentType },
      expiresAt,
      fileUrl: `${config.appUrl}/api/media/${id}`,
    },
    { status: 201, headers: { "Cache-Control": "no-store" } },
  );
}
