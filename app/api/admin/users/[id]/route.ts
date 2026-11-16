/**
 * PATCH /api/admin/users/:id — блокировка и разблокировка.
 * DELETE /api/admin/users/:id — удаление со всеми данными пачками.
 */
import type { NextRequest } from "next/server";

import { checkOrigin, requireOperatorApi } from "@/lib/auth/guard";
import { deleteUserData } from "@/lib/admin/delete";
import { setUserBlocked } from "@/lib/admin/users";
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
  if (!isUuid(id)) return errorResponse(404, "not_found", "Пользователь не найден");

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse(400, "invalid_request", "Ожидается JSON с полем blocked");
  }
  const blocked =
    body !== null && typeof body === "object" && "blocked" in body
      ? (body as { blocked?: unknown }).blocked
      : undefined;
  if (typeof blocked !== "boolean") {
    return errorResponse(400, "invalid_request", "Поле blocked должно быть логическим значением");
  }

  const result = await setUserBlocked({ operatorId: operator.id, userId: id, blocked });
  if (result.status === "updated") {
    return Response.json(result.item, { headers: NO_STORE });
  }
  if (result.status === "not_found") {
    return errorResponse(404, "not_found", "Пользователь не найден");
  }
  return errorResponse(409, "conflict", result.message);
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
  if (!isUuid(id)) return errorResponse(404, "not_found", "Пользователь не найден");

  const result = await deleteUserData(id, operator.id);
  switch (result.status) {
    case "deleted":
      return new Response(null, { status: 204, headers: NO_STORE });
    case "progress":
      return Response.json(
        {
          done: false,
          deleted: result.deleted,
          total: result.total,
          remaining: { sessions: result.remaining },
        },
        { status: 202, headers: NO_STORE },
      );
    case "not_found":
      return errorResponse(404, "not_found", "Пользователь не найден");
    case "busy":
    case "conflict":
      return errorResponse(409, "conflict", result.message);
    case "failed":
      return errorResponse(502, "upstream_error", result.message);
  }
}
