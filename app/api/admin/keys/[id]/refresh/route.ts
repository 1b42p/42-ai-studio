/** POST /api/admin/keys/:id/refresh — перечитать использование. */
import type { NextRequest } from "next/server";

import { checkOrigin, requireOperatorApi } from "@/lib/auth/guard";
import { refreshAdminKey } from "@/lib/admin/keys";
import { loadConfig } from "@/lib/config";
import { errorResponse } from "@/lib/http/errors";
import { isUuid } from "@/lib/sessions/access";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const operator = await requireOperatorApi(request);
  if (operator instanceof Response) return operator;

  const originError = checkOrigin(request, loadConfig().appUrl);
  if (originError !== null) return originError;

  const { id } = await context.params;
  if (!isUuid(id)) return errorResponse(404, "not_found", "Ключ не найден.");

  const result = await refreshAdminKey(id);
  if (!result.ok) return errorResponse(result.error.status, result.error.code, result.error.message);
  return Response.json(result.value, { headers: NO_STORE });
}
