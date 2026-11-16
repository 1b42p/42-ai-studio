export class McpBodyError extends Error {}

export async function readMcpJson(request: Request): Promise<unknown> {
  if (!request.body) throw new SyntaxError();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
      size += value.length;
      if (size > 64 * 1024) {
        await reader.cancel();
        throw new McpBodyError("Размер запроса не должен превышать 64 КиБ.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
}
