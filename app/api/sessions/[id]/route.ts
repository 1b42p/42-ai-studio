/** GET /api/sessions/:id — состояние сессии для страницы и тестов. */
import type { NextRequest } from "next/server";

import { checkOrigin, requireApiUser } from "@/lib/auth/guard";
import { loadConfig } from "@/lib/config";
import { getSqlClient } from "@/lib/db/client";
import { deleteSessionData } from "@/lib/sessions/delete";
import { errorResponse } from "@/lib/http/errors";
import { isUuid } from "@/lib/sessions/access";
import { findUserSession } from "@/lib/sessions/service";

export const dynamic = "force-dynamic";
export const maxDuration = 125;

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const user = await requireApiUser(request);
  if (user instanceof Response) return user;

  const { id } = await context.params;
  if (!isUuid(id)) return errorResponse(404, "not_found", "Сессия не найдена");

  const session = await findUserSession(user.id, id);
  if (session === null) return errorResponse(404, "not_found", "Сессия не найдена");

  return Response.json(
    {
      id: session.id,
      title: session.title,
      eveSessionId: session.eveSessionId,
      streamCursor: session.streamCursor,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const user = await requireApiUser(request);
  if (user instanceof Response) return user;
  const denied = checkOrigin(request, loadConfig().appUrl);
  if (denied) return denied;
  const { id } = await context.params;
  if (!isUuid(id)) return errorResponse(404, "not_found", "Сессия не найдена");
  // DELETE — единственное пользовательское чтение, которому видна tombstone.
  const [session] = await getSqlClient()`select id from app_sessions where id = ${id} and user_id = ${user.id}
    union all select id from session_deletions where id = ${id} and user_id = ${user.id}`;
  if (!session) return errorResponse(404, "not_found", "Сессия не найдена");
  const result = await deleteSessionData(id);
  if (result.status === "deleted") return new Response(null, { status: 204 });
  if (result.status === "not_found") return errorResponse(404, "not_found", "Сессия не найдена");
  if (result.status === "conflict") return errorResponse(409, "conflict", result.message!);
  return errorResponse(502, "upstream_error", result.message!);
}
