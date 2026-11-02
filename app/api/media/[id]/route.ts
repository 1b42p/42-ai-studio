/**
 * GET /api/media/:id — временная ссылка на объект S3 (#8).
 *
 * Ссылка живёт 15 минут и создаётся заново на каждый запрос: постоянных
 * публичных адресов нет. Песочница не нужна. `?download=1` и невстраиваемые
 * типы (в том числе `text/html` и `application/pdf`) отдаются как скачивание.
 */
import type { NextRequest } from "next/server";

import { requireApiUser } from "@/lib/auth/guard";
import { errorResponse } from "@/lib/http/errors";
import { isInlineMediaType, MEDIA_URL_TTL_SECONDS } from "@/lib/media/files";
import { findMediaForUser } from "@/lib/media/service";
import { getStorage } from "@/lib/s3";
import { isUuid } from "@/lib/sessions/access";

export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const user = await requireApiUser(request);
  if (user instanceof Response) return user;

  const { id } = await context.params;
  if (!isUuid(id)) return errorResponse(404, "not_found", "Файл не найден");

  const record = await findMediaForUser(id, user.id);
  if (record === null) return errorResponse(404, "not_found", "Файл не найден");

  // `retry` из клиента не влияет на ответ: он только меняет адрес после ошибки.
  const download =
    request.nextUrl.searchParams.get("download") === "1" ||
    !isInlineMediaType(record.contentType);

  const location = await getStorage().presignRead(record.objectKey, {
    expiresIn: MEDIA_URL_TTL_SECONDS,
    downloadName: download ? record.originalName : undefined,
  });

  return new Response(null, {
    status: 302,
    headers: { Location: location, "Cache-Control": "private, no-store" },
  });
}
