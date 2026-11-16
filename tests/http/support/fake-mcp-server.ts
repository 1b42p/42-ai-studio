import { createServer, type ServerResponse } from "node:http";
import { OAUTH_ORIGIN, OAUTH_RESOURCE, type FakeOAuthState } from "./fake-oauth-provider";

export interface FakeMcpRequest {
  method: string;
  path: string;
  headers: Record<string, string | undefined>;
}

export async function startFakeMcpServer(port: number, oauth?: FakeOAuthState) {
  const requests: FakeMcpRequest[] = [];
  let legacyStream: ServerResponse | undefined;
  const server = createServer(async (request, response) => {
    const path = request.url ?? "/";
    if (path === "/__requests") {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(requests));
      return;
    }
    if (path === "/__reset" && request.method === "POST") {
      requests.length = 0;
      response.writeHead(204).end();
      return;
    }
    requests.push({
      method: request.method ?? "GET", path,
      headers: Object.fromEntries(["authorization", "x-api-key", "cookie", "x-studio-mcp-token", "user-agent", "mcp-session-id"]
        .map((name) => [name, request.headers[name] as string | undefined])),
    });
    if (path === "/.well-known/oauth-protected-resource/mcp-oauth") {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
        resource: oauth?.modes.foreignResource ? "https://foreign.example/mcp" : OAUTH_RESOURCE,
        authorization_servers: [OAUTH_ORIGIN], scopes_supported: ["mcp:read"],
      }));
      return;
    }
    if (path.startsWith("/mcp-oauth") && !oauth?.accepts(request.headers.authorization)) {
      response.writeHead(401, {
        "www-authenticate": `Bearer resource_metadata="http://127.0.0.1:${port}/.well-known/oauth-protected-resource/mcp-oauth", scope="mcp:read"`,
      }).end();
      return;
    }
    if ((path.startsWith("/bearer") || path.startsWith("/mcp-bearer")) && request.headers.authorization !== "Bearer secret-token") {
      response.writeHead(401).end(); return;
    }
    if ((path.startsWith("/headers") || path.startsWith("/mcp-headers")) && request.headers["x-api-key"] !== "k1") {
      response.writeHead(401).end(); return;
    }
    if (path.startsWith("/redirect") || path.startsWith("/mcp-redirect")) {
      response.writeHead(302, { location: "/mcp" }).end(); return;
    }
    if (path.startsWith("/not-mcp")) { response.writeHead(200, { "content-type": "text/html" }).end("<p>hello</p>"); return; }
    if (path.startsWith("/forbidden") || path.startsWith("/mcp-403")) { response.writeHead(403).end(); return; }
    if (path.startsWith("/mcp-hang")) return;
    if (path.startsWith("/mcp-big")) { response.writeHead(200, { "content-length": 16 * 1024 * 1024 + 1 }); response.end(Buffer.alloc(16 * 1024 * 1024 + 1)); return; }
    if (path.startsWith("/legacy/sse") || path.startsWith("/mcp-sse-legacy/sse")) {
      if (request.method === "POST") {
        const code = Number(new URL(path, "http://localhost").searchParams.get("fallback") ?? "405");
        response.writeHead(code).end(); return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(`: keepalive\n\nevent: endpoint\ndata: ${path.startsWith("/legacy/") ? "/legacy/messages" : "/mcp-sse-legacy/messages"}?sessionId=legacy\n\n`);
      legacyStream = response;
      return;
    }
    if (request.method === "GET") {
      if (path.startsWith("/big-sse")) {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(`event: message\ndata: ${"x".repeat(100_000)}\n\n`);
      } else if (path.startsWith("/sse")) {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write("event: endpoint\ndata: /messages?sessionId=abc\n\n");
      } else if (path.startsWith("/evil") || path.startsWith("/mcp-sse-evil/sse")) {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end("event: endpoint\ndata: http://example.invalid/messages\n\n");
      } else if (path.startsWith("/mcp-stream")) {
        response.writeHead(200, { "content-type": "text/event-stream" });
        const timer = setInterval(() => response.write("event: message\ndata: test\n\n"), 1_000);
        response.on("close", () => clearInterval(timer));
      } else response.writeHead(405).end();
      return;
    }
    if (request.method === "DELETE") { response.writeHead(200).end(); return; }
    let body = "";
    for await (const chunk of request) body += chunk;
    let message: { jsonrpc: string; id?: number; method: string; params?: { arguments?: { text?: string } } };
    try { message = JSON.parse(body); } catch { response.writeHead(400).end(); return; }
    const legacy = path.startsWith("/legacy/messages") || path.startsWith("/mcp-sse-legacy/messages");
    if (message.method === "notifications/initialized") { response.writeHead(202).end(); return; }
    const result = message.method === "initialize"
      ? { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } }
      : message.method === "tools/call"
        ? { content: [{ type: "text", text: `echo: ${message.params?.arguments?.text}` }] }
        : { tools: [{ name: "echo", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }] };
    const payload = !["initialize", "tools/list", "tools/call"].includes(message.method)
      ? { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } }
      : { jsonrpc: "2.0", id: message.id, result };
    if (legacy) {
      response.writeHead(202).end();
      if (message.id !== undefined) legacyStream?.write(`event: message\ndata: ${JSON.stringify(payload)}\n\n`);
    } else if (path.startsWith("/post-sse")) {
      response.writeHead(200, { "content-type": "text/event-stream", "mcp-session-id": "test-session" });
      response.write(`event: message\ndata: ${JSON.stringify(payload)}\n\n`);
    } else {
      response.writeHead(200, { "content-type": "application/json", "mcp-session-id": "test-session" });
      response.end(JSON.stringify(payload));
    }
  });
  await new Promise<void>((resolve, reject) => server.once("error", reject).listen(port, "127.0.0.1", resolve));
  return {
    close: async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); },
  };
}
