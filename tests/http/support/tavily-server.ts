/** HTTP-подмена внешнего Tavily. Управление доступно только с loopback. */
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export const TAVILY_PORT = 59102;
export const TAVILY_RAW_ERROR = "tavily-raw-error-must-not-leak";
export type TavilyMode = "ok" | "empty" | "non_json" | "invalid_payload" | "400" | "401" | "422" | "429" | "432" | "433" | "500";
const MODES: readonly TavilyMode[] = ["ok", "empty", "non_json", "invalid_payload", "400", "401", "422", "429", "432", "433", "500"];

export interface TavilyCall {
  headers: IncomingHttpHeaders;
  body: Record<string, unknown>;
  at: number;
}

export interface TavilyServer {
  url: string;
  close(): Promise<void>;
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(body));
}

export function startTavilyServer(port = TAVILY_PORT): Promise<TavilyServer> {
  let mode: TavilyMode = "ok";
  let remaining: number | null = null;
  let retryAfter = "1";
  let calls: TavilyCall[] = [];
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (path === "/__control" || path === "/__calls") {
      const address = request.socket.remoteAddress;
      if (address !== "127.0.0.1" && address !== "::1" && address !== "::ffff:127.0.0.1") {
        response.writeHead(403).end();
        return;
      }
      if (request.method === "GET" && path === "/__calls") {
        json(response, 200, calls);
        return;
      }
      if (request.method === "POST" && path === "/__control") {
        void readJson(request).then((body) => {
          if (!MODES.includes(body.mode as TavilyMode) ||
              (body.count != null && (!Number.isInteger(body.count) || Number(body.count) < 1)) ||
              (body.retryAfter !== undefined && typeof body.retryAfter !== "string")) {
            json(response, 400, { ok: false });
            return;
          }
          mode = body.mode as TavilyMode;
          remaining = body.count == null ? null : Number(body.count);
          retryAfter = typeof body.retryAfter === "string" ? body.retryAfter : "1";
          calls = [];
          json(response, 200, { ok: true });
        }).catch(() => json(response, 400, { ok: false }));
        return;
      }
    }
    if (request.method !== "POST" || path !== "/search") {
      response.writeHead(404).end();
      return;
    }
    void readJson(request).then((body) => {
      calls.push({ headers: request.headers, body, at: Date.now() });
      const current = mode;
      if (remaining !== null && --remaining === 0) { mode = "ok"; remaining = null; }
      const requestId = `tavily-request-${calls.length}`;
      response.setHeader("x-request-id", requestId);
      // Намеренно отражаем секрет в ошибках: приложение не должно публиковать
      // сырое тело ни при ошибке JSON, ни при известном статусе.
      const rawError = `${TAVILY_RAW_ERROR} ${request.headers.authorization ?? ""}`;
      if (current === "non_json") {
        response.writeHead(200, { "Content-Type": "text/html" });
        response.end(`<h1>${rawError}</h1>`);
        return;
      }
      if (/^\d+$/.test(current)) {
        if (current === "429") response.setHeader("Retry-After", retryAfter);
        json(response, Number(current), { request_id: requestId, detail: { error: rawError } });
        return;
      }
      if (current === "invalid_payload") {
        json(response, 200, { request_id: requestId, results: [{ content: rawError }] });
        return;
      }
      const results = [
        { title: "Captions", url: "https://www.remotion.dev/docs/captions", content: "Субтитры и время каждого слова.", score: 0.95 },
        { title: "Sequence", url: "https://www.remotion.dev/docs/sequence", content: "Размещение фрагментов на временной шкале.", score: 0.9 },
        { title: "Audio", url: "https://www.remotion.dev/docs/audio", content: "Аудиодорожка и озвучка видео.", score: 0.85 },
      ].map((row) => body.topic === "news" ? { ...row, published_date: "2026-11-04" } : row);
      json(response, 200, {
        query: body.query, request_id: requestId,
        results: current === "empty" ? [] : results.slice(0, Number(body.max_results ?? 5)),
      });
    }).catch(() => { if (!response.headersSent) json(response, 400, { detail: { error: "Invalid request" } }); });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve({
      url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      close: () => new Promise<void>((done, fail) => server.close((error) => error ? fail(error) : done())),
    }));
  });
}
