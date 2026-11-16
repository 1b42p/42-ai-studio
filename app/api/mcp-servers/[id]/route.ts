import { and, eq } from "drizzle-orm";

import { checkOrigin, requireApiUser } from "@/lib/auth/guard";
import { loadConfig } from "@/lib/config";
import { getDb } from "@/lib/db/client";
import { mcpServers } from "@/lib/db/schema";
import { errorResponse } from "@/lib/http/errors";
import { findMcpServer, serializeServer } from "@/lib/mcp/service";
import { McpBodyError, readMcpJson } from "@/lib/mcp/read-json";

type Context = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, context: Context): Promise<Response> {
  const user = await requireApiUser(request);
  if (user instanceof Response) return user;
  const origin = checkOrigin(request, loadConfig().appUrl);
  if (origin) return origin;
  const { id } = await context.params;
  if (!(await findMcpServer(user.id, id))) return errorResponse(404, "not_found", "Сервер не найден.");
  let body: unknown;
  try { body = await readMcpJson(request); }
  catch (error) {
    if (error instanceof McpBodyError) return errorResponse(413, "too_large", error.message);
    return errorResponse(400, "invalid_request", "Некорректный запрос.");
  }
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 1 ||
      typeof (body as { enabled?: unknown }).enabled !== "boolean") {
    return errorResponse(400, "invalid_request", "Некорректный запрос.");
  }
  const [updated] = await getDb().update(mcpServers).set({
    enabled: (body as { enabled: boolean }).enabled, updatedAt: new Date(),
  }).where(and(eq(mcpServers.id, id), eq(mcpServers.userId, user.id))).returning();
  return updated ? Response.json(serializeServer(updated)) : errorResponse(404, "not_found", "Сервер не найден.");
}

export async function DELETE(request: Request, context: Context): Promise<Response> {
  const user = await requireApiUser(request);
  if (user instanceof Response) return user;
  const origin = checkOrigin(request, loadConfig().appUrl);
  if (origin) return origin;
  const { id } = await context.params;
  if (!(await findMcpServer(user.id, id))) return errorResponse(404, "not_found", "Сервер не найден.");
  const deleted = await getDb().delete(mcpServers).where(and(eq(mcpServers.id, id), eq(mcpServers.userId, user.id))).returning({ id: mcpServers.id });
  return deleted.length ? new Response(null, { status: 204 }) : errorResponse(404, "not_found", "Сервер не найден.");
}
