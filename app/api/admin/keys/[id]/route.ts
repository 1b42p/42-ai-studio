/**
 * PATCH /api/admin/keys/:id — включить или отключить.
 * DELETE /api/admin/keys/:id — удалить ключ и его песочницы.
 */
import type { NextRequest } from "next/server";

import { checkOrigin, requireOperatorApi } from "@/lib/auth/guard";
import { deleteAdminKey, setAdminKeyEnabled } from "@/lib/admin/keys";
import { loadConfig } from "@/lib/config";
import { errorResponse } from "@/lib/http/errors";
import { isUuid } from "@/lib/sessions/access";

export const dynamic = "force-dynamic";
export const maxDuration = 125;

const NO_STORE = { "Cache-Control": "no-store" } as const;

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const operator = await requireOperatorApi(request);
  if (operator instanceof Response) return operator;

  const originError = checkOrigin(request, loadConfig().appUrl);
  if (originError !== null) return originError;

  const { id } = await context.params;
  if (!isUuid(id)) return errorResponse(404, "not_found", "Ключ не найден.");

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse(400, "invalid_request", "Ожидается JSON с полем enabled.");
  }
  const enabled =
    body !== null && typeof body === "object" && "enabled" in body
      ? (body as { enabled?: unknown }).enabled
      : undefined;
  const result = await setAdminKeyEnabled(id, enabled);
  if (!result.ok) return errorResponse(result.error.status, result.error.code, result.error.message);
  return Response.json(result.value, { headers: NO_STORE });
}

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const operator = await requireOperatorApi(request);
  if (operator instanceof Response) return operator;

  const originError = checkOrigin(request, loadConfig().appUrl);
  if (originError !== null) return originError;

  const { id } = await context.params;
  if (!isUuid(id)) return errorResponse(404, "not_found", "Ключ не найден.");

  try {
    const result = await deleteAdminKey(id);
    if (!result.ok) return errorResponse(result.error.status, result.error.code, result.error.message);
    return Response.json(result.value, { headers: NO_STORE });
  } catch {
    return errorResponse(502, "upstream_error", "Не удалось удалить ключ. Попробуйте ещё раз.");
  }
}
