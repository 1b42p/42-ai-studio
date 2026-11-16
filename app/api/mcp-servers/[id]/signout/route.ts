import { checkOrigin, requireApiUser } from "@/lib/auth/guard";
import { loadConfig } from "@/lib/config";
import { errorResponse } from "@/lib/http/errors";
import { revokeMcpOAuthCredentials } from "@/lib/mcp/oauth";
import { findMcpServer } from "@/lib/mcp/service";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const user = await requireApiUser(request);
  if (user instanceof Response) return user;
  const origin = checkOrigin(request, loadConfig().appUrl);
  if (origin) return origin;
  const { id } = await context.params;
  const server = await findMcpServer(user.id, id);
  if (!server) return errorResponse(404, "not_found", "Сервер не найден.");
  if (server.authKind !== "oauth") {
    return errorResponse(400, "invalid_request", "Сброс входа доступен только для OAuth.");
  }
  await revokeMcpOAuthCredentials(id);
  return new Response(null, { status: 204 });
}
