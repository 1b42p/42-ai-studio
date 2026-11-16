import type { NextRequest } from "next/server";

import { reconcileAdminSandboxes } from "@/lib/admin/reconcile";
import { getAdminUsage, parseAdminUsageSearchParams } from "@/lib/admin/usage";
import { requireOperatorApi } from "@/lib/auth/guard";
import { errorResponse } from "@/lib/http/errors";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<Response> {
  const operator = await requireOperatorApi(request);
  if (operator instanceof Response) return operator;
  try {
    const parsed = await parseAdminUsageSearchParams(request.nextUrl.searchParams);
    if (!parsed.ok) return errorResponse(400, "invalid_request", parsed.message);
    await reconcileAdminSandboxes();
    return Response.json(await getAdminUsage(parsed.request), { headers: { "Cache-Control": "no-store" } });
  } catch {
    return errorResponse(503, "unavailable", "Не удалось загрузить данные");
  }
}
