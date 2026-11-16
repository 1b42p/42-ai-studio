import { checkOrigin, requireApiUser } from "@/lib/auth/guard";
import { loadConfig } from "@/lib/config";
import { errorResponse } from "@/lib/http/errors";
import { checkMcpServer } from "@/lib/mcp/check";
import { findMcpServer } from "@/lib/mcp/service";
import { allowMcpCheck } from "@/lib/mcp/rate-limit";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const user = await requireApiUser(request);
  if (user instanceof Response) return user;
  const origin = checkOrigin(request, loadConfig().appUrl);
  if (origin) return origin;
  const { id } = await context.params;
  const server = await findMcpServer(user.id, id);
  if (!server) return errorResponse(404, "not_found", "Сервер не найден.");
  if (!allowMcpCheck(user.id)) return errorResponse(429, "rate_limit", "Слишком много проверок. Попробуйте через минуту.");
  return Response.json(await checkMcpServer(server), { headers: { "Cache-Control": "no-store" } });
}
