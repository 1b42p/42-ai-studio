/** GET /api/sessions/:id — состояние сессии для страницы и тестов. */
import type { NextRequest } from "next/server";

import { requireApiUser } from "@/lib/auth/guard";
import { errorResponse } from "@/lib/http/errors";
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
