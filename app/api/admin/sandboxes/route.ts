import type { NextRequest } from "next/server";

import { reconcileAdminSandboxes } from "@/lib/admin/reconcile";
import { getAdminSandboxes } from "@/lib/admin/sandboxes";
import { requireOperatorApi } from "@/lib/auth/guard";
import { errorResponse } from "@/lib/http/errors";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<Response> {
  const operator = await requireOperatorApi(request);
  if (operator instanceof Response) return operator;
  try {
    await reconcileAdminSandboxes();
    return Response.json(await getAdminSandboxes(), { headers: { "Cache-Control": "no-store" } });
  } catch {
    return errorResponse(503, "unavailable", "Не удалось загрузить данные");
  }
}
