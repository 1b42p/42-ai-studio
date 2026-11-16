import { checkOrigin, requireApiUser } from "@/lib/auth/guard";
import { loadConfig } from "@/lib/config";
import { errorResponse } from "@/lib/http/errors";
import { McpValidationError } from "@/lib/mcp/credentials";
import { McpBodyError, readMcpJson } from "@/lib/mcp/read-json";
import { createMcpServer, listMcpServers, McpConflictError, serializeServer } from "@/lib/mcp/service";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const user = await requireApiUser(request);
  if (user instanceof Response) return user;
  return Response.json({ servers: (await listMcpServers(user.id)).map(serializeServer) }, {
    headers: { "Cache-Control": "no-store" },
  });
}

export async function POST(request: Request): Promise<Response> {
  const user = await requireApiUser(request);
  if (user instanceof Response) return user;
  const origin = checkOrigin(request, loadConfig().appUrl);
  if (origin) return origin;
  try {
    const data = await readMcpJson(request);
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new McpValidationError("Укажите название сервера (до 60 символов).");
    const server = await createMcpServer(user.id, data as Record<string, unknown>);
    return Response.json(serializeServer(server), { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof McpConflictError) return errorResponse(409, "conflict", error.message);
    if (error instanceof McpBodyError) return errorResponse(413, "too_large", error.message);
    if (error instanceof McpValidationError) return errorResponse(400, "invalid_request", error.message);
    if (error instanceof SyntaxError) return errorResponse(400, "invalid_request", "Укажите название сервера (до 60 символов).");
    throw error;
  }
}
