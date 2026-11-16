/** GET /api/admin/users — список пользователей для оператора. */
import type { NextRequest } from "next/server";

import { requireOperatorApi } from "@/lib/auth/guard";
import { listAdminUsers, parseAdminUsersSearchParams } from "@/lib/admin/users";
import { errorResponse } from "@/lib/http/errors";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<Response> {
  const operator = await requireOperatorApi(request);
  if (operator instanceof Response) return operator;

  const parsed = parseAdminUsersSearchParams(request.nextUrl.searchParams);
  if (!parsed.ok) return errorResponse(400, "invalid_request", parsed.message);

  const page = await listAdminUsers(parsed.request);
  return Response.json(page, { headers: { "Cache-Control": "no-store" } });
}
