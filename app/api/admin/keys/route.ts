/** GET/POST /api/admin/keys — список и добавление ключей Daytona. */
import type { NextRequest } from "next/server";

import { checkOrigin, requireOperatorApi } from "@/lib/auth/guard";
import { addAdminKey, listAdminKeys, parseDeletedFilter } from "@/lib/admin/keys";
import { loadConfig } from "@/lib/config";
import { errorResponse } from "@/lib/http/errors";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;
const BODY_LIMIT = 8 * 1024;

export async function GET(request: NextRequest): Promise<Response> {
  const operator = await requireOperatorApi(request);
  if (operator instanceof Response) return operator;

  const parsed = parseDeletedFilter(request.nextUrl.searchParams.get("deleted"));
  if (!parsed.ok) return errorResponse(parsed.error.status, parsed.error.code, parsed.error.message);

  const page = await listAdminKeys(parsed.value);
  return Response.json(page, { headers: NO_STORE });
}

export async function POST(request: NextRequest): Promise<Response> {
  const operator = await requireOperatorApi(request);
  if (operator instanceof Response) return operator;

  const originError = checkOrigin(request, loadConfig().appUrl);
  if (originError !== null) return originError;

  const text = await request.text();
  if (text.length > BODY_LIMIT) {
    return errorResponse(400, "invalid_request", "Укажите название и ключ.");
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return errorResponse(400, "invalid_request", "Ожидается JSON с названием и ключом.");
  }
  const record = body !== null && typeof body === "object" ? body as { label?: unknown; apiKey?: unknown } : {};
  const result = await addAdminKey(record);
  if (!result.ok) return errorResponse(result.error.status, result.error.code, result.error.message);
  console.info(`[admin:key] added ${result.value.id}`);
  return Response.json(result.value, { status: 201, headers: NO_STORE });
}
