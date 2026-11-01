/**
 * POST /api/sessions — строка `app_sessions` перед первой отправкой.
 * GET /api/sessions — список сессий текущего пользователя.
 * Сессия eve создаётся клиентом чата отдельным запросом с заголовком
 * `x-studio-session-id`; POST здесь только её будущий адрес.
 */
import type { NextRequest } from "next/server";

import { checkOrigin, requireApiUser } from "@/lib/auth/guard";
import { loadConfig } from "@/lib/config";
import { errorResponse } from "@/lib/http/errors";
import { listUserSessions, parseSessionListSearchParams } from "@/lib/sessions/list";
import { createAppSession } from "@/lib/sessions/service";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<Response> {
  const user = await requireApiUser(request);
  if (user instanceof Response) return user;

  const parsed = parseSessionListSearchParams(request.nextUrl.searchParams);
  if (!parsed.ok) return errorResponse(400, "invalid_request", parsed.message);

  const page = await listUserSessions(user.id, parsed.request);
  return Response.json(page, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: NextRequest): Promise<Response> {
  const user = await requireApiUser(request);
  if (user instanceof Response) return user;

  const originError = checkOrigin(request, loadConfig().appUrl);
  if (originError !== null) return originError;

  const session = await createAppSession(user.id);

  return Response.json({ id: session.id }, { status: 201, headers: { "Cache-Control": "no-store" } });
}
