/**
 * GET /api/sessions/:id/events?after=&limit= — сохранённые события потока
 * по возрастанию `seq` и курсор потока на момент чтения.
 */
import type { NextRequest } from "next/server";

import { requireApiUser } from "@/lib/auth/guard";
import { errorResponse } from "@/lib/http/errors";
import { isUuid } from "@/lib/sessions/access";
import { findAppSessionForUser, readSessionEvents } from "@/lib/sessions/service";

export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 2000;
const MAX_LIMIT = 5000;

function parseInteger(value: string): number | null {
  if (!/^-?\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const user = await requireApiUser(request);
  if (user instanceof Response) return user;

  const { id } = await context.params;
  if (!isUuid(id)) return errorResponse(404, "not_found", "Сессия не найдена");

  const afterParam = request.nextUrl.searchParams.get("after");
  const limitParam = request.nextUrl.searchParams.get("limit");
  const after = afterParam === null ? -1 : parseInteger(afterParam);
  const limit = limitParam === null ? DEFAULT_LIMIT : parseInteger(limitParam);

  if (after === null || after < -1) {
    return errorResponse(400, "invalid_request", "Параметр after должен быть целым числом от -1");
  }
  if (limit === null || limit < 1 || limit > MAX_LIMIT) {
    return errorResponse(
      400,
      "invalid_request",
      `Параметр limit должен быть целым числом от 1 до ${MAX_LIMIT}`,
    );
  }

  const session = await findAppSessionForUser(id, user.id);
  if (session === null) return errorResponse(404, "not_found", "Сессия не найдена");

  const result = await readSessionEvents(id, { after, limit });
  if (result === null) return errorResponse(404, "not_found", "Сессия не найдена");

  return Response.json(result, { headers: { "Cache-Control": "no-store" } });
}
