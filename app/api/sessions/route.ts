/**
 * POST /api/sessions — строка `app_sessions` перед первой отправкой.
 * Сессия eve создаётся клиентом чата отдельным запросом с заголовком
 * `x-studio-session-id`; здесь только её будущий адрес.
 */
import type { NextRequest } from "next/server";

import { checkOrigin, requireApiUser } from "@/lib/auth/guard";
import { loadConfig } from "@/lib/config";
import { createAppSession } from "@/lib/sessions/service";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest): Promise<Response> {
  const user = await requireApiUser(request);
  if (user instanceof Response) return user;

  const originError = checkOrigin(request, loadConfig().appUrl);
  if (originError !== null) return originError;

  const session = await createAppSession(user.id);

  return Response.json({ id: session.id }, { status: 201, headers: { "Cache-Control": "no-store" } });
}
