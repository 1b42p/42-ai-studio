import type { NextRequest } from "next/server";

import { requireApiUser } from "@/lib/auth/guard";
import { errorResponse } from "@/lib/http/errors";
import { getSandboxStatus } from "@/lib/sandbox/queue-state";
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
  if (!isUuid(id) || await findAppSessionForUser(id, user.id) === null) {
    return errorResponse(404, "not_found", "Сессия не найдена");
  }
  return Response.json(await getSandboxStatus(id), { headers: { "Cache-Control": "no-store" } });
}
