import { proxyMcp } from "@/lib/mcp/proxy";

type Context = { params: Promise<{ id: string }> };
const handler = async (request: Request, context: Context) => proxyMcp(request, (await context.params).id);

export const GET = handler;
export const POST = handler;
export const DELETE = handler;
