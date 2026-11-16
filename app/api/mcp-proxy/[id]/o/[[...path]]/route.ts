import { proxyMcp } from "@/lib/mcp/proxy";

type Context = { params: Promise<{ id: string; path?: string[] }> };
const handler = async (request: Request, context: Context) => {
  const { id, path } = await context.params;
  return proxyMcp(request, id, `/${(path ?? []).map(encodeURIComponent).join("/")}${new URL(request.url).search}`);
};

export const GET = handler;
export const POST = handler;
export const DELETE = handler;
