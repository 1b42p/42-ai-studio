/**
 * GET /api/sessions/:id/files — файлы из ответов агента по всем сообщениям
 * сессии (#8). Песочница не запускается: данные берутся из `message_files`.
 */
import type { NextRequest } from "next/server";

import { requireApiUser } from "@/lib/auth/guard";
import { errorResponse } from "@/lib/http/errors";
import { listSessionFiles } from "@/lib/media/service";
import type { MessageFilesResponse } from "@/lib/media/types";
import { isUuid } from "@/lib/sessions/access";
import { findAppSessionForUser } from "@/lib/sessions/service";

export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const user = await requireApiUser(request);
  if (user instanceof Response) return user;

  const { id } = await context.params;
  if (!isUuid(id)) return errorResponse(404, "not_found", "Сессия не найдена");

  const session = await findAppSessionForUser(id, user.id);
  if (session === null) return errorResponse(404, "not_found", "Сессия не найдена");

  const body: MessageFilesResponse = { files: await listSessionFiles(id) };
  return Response.json(body, { headers: { "Cache-Control": "no-store" } });
}
