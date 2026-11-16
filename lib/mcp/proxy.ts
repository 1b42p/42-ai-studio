import { eq } from "drizzle-orm";
import { fetch, Headers as UndiciHeaders } from "undici";

import { verifyInternalToken } from "@/lib/auth/internal-tokens";
import { loadConfig } from "@/lib/config";
import { getDb } from "@/lib/db/client";
import { mcpServers, users } from "@/lib/db/schema";
import { errorResponse } from "@/lib/http/errors";
import { checkOutboundAddress, classifySafeFetchError, createSafeAgent, SafeFetchError } from "@/lib/web/safe-fetch";

import { serverHeaders } from "./check";
import { mcpPolicy } from "./policy";
import { rewriteEndpointEvent } from "./legacy-sse";

const MAX_REQUEST = 4 * 1024 * 1024;
const MAX_RESPONSE = 16 * 1024 * 1024;
const REQUEST_HEADERS = ["accept", "content-type", "mcp-session-id", "mcp-protocol-version", "last-event-id"];
const RESPONSE_HEADERS = ["content-type", "mcp-session-id", "mcp-protocol-version", "www-authenticate", "retry-after", "cache-control"];

function upstreamError(reason: string): Response {
  const response = errorResponse(502, "upstream_error", "Не удалось связаться с MCP-сервером.");
  response.headers.set("x-studio-proxy-reason", reason);
  return response;
}

async function requestBody(request: Request): Promise<Buffer | null> {
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return Buffer.concat(chunks, size);
      size += value.length;
      if (size > MAX_REQUEST) {
        await reader.cancel();
        throw new SafeFetchError("too_large");
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
}

export async function proxyMcp(request: Request, id: string, endpoint?: string): Promise<Response> {
  const started = performance.now();
  let status = 500;
  let bytes = 0;
  let responseLogged = false;
  const log = () => {
    if (responseLogged) return;
    responseLogged = true;
    console.info("[mcp-proxy]", { serverId: id, method: request.method, status, durationMs: Math.round(performance.now() - started), bytes });
  };
  const deny = (response: Response) => { status = response.status; log(); return response; };
  const token = request.headers.get("x-studio-mcp-token");
  if (!token) return deny(errorResponse(401, "unauthenticated", "Требуется вход."));
  let claims;
  try { claims = await verifyInternalToken(token); }
  catch { return deny(errorResponse(401, "unauthenticated", "Требуется вход.")); }
  if (claims.purpose !== "mcp_proxy" || typeof claims.uid !== "string" || typeof claims.srv !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(claims.uid)) {
    return deny(errorResponse(403, "forbidden", "Доступ закрыт."));
  }
  if (claims.srv !== id) return deny(errorResponse(403, "forbidden", "Доступ закрыт."));
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return deny(errorResponse(404, "not_found", "Сервер не найден."));
  }
  const [server] = await getDb().select().from(mcpServers).where(eq(mcpServers.id, id)).limit(1);
  if (!server || !server.enabled) return deny(errorResponse(404, "not_found", "Сервер не найден."));
  if (server.userId !== claims.uid) return deny(errorResponse(403, "forbidden", "Доступ закрыт."));
  const [user] = await getDb().select({ blocked: users.isBlocked }).from(users).where(eq(users.id, claims.uid)).limit(1);
  if (!user || user.blocked) return deny(errorResponse(403, "forbidden", "Доступ закрыт."));

  const original = new URL(server.url);
  let target = original;
  if (endpoint !== undefined) {
    try {
      target = new URL(endpoint, original.origin);
      if (target.origin !== original.origin) return deny(upstreamError("redirect"));
    } catch { return deny(upstreamError("redirect")); }
  }
  const policy = mcpPolicy();
  if (target.protocol !== "https:" && server.authKind !== "none" &&
      !loadConfig().ssrfTestAllowHosts.includes(`${target.hostname}:${target.port || "80"}`)) {
    return deny(upstreamError("blocked_address"));
  }
  let body: Buffer | null;
  try { body = await requestBody(request); }
  catch {
    const response = errorResponse(413, "too_large", "Размер запроса превышает 4 МиБ.");
    response.headers.set("Connection", "close");
    return deny(response);
  }
  let headers: UndiciHeaders;
  try { headers = new UndiciHeaders(serverHeaders(server)); }
  catch { return deny(upstreamError("unreachable")); }
  for (const key of REQUEST_HEADERS) {
    const value = request.headers.get(key);
    if (value !== null) headers.set(key, value);
  }
  const abort = new AbortController();
  const deadline = setTimeout(() => abort.abort(new SafeFetchError("timeout")), 30_000);
  const signal = AbortSignal.any([abort.signal, request.signal]);
  const agent = createSafeAgent(policy);
  try {
    await checkOutboundAddress(target.href, policy, signal);
    const upstream = await fetch(target, {
      method: request.method, headers, body, redirect: "manual", dispatcher: agent, signal,
    });
    clearTimeout(deadline);
    if (upstream.status >= 300 && upstream.status < 400) {
      abort.abort();
      await agent.destroy();
      return deny(upstreamError("redirect"));
    }
    if (upstream.status === 401 && server.authKind !== "oauth") {
      abort.abort();
      await agent.destroy();
      return deny(upstreamError("unauthorized"));
    }
    const responseHeaders = new Headers();
    for (const key of RESPONSE_HEADERS) {
      const value = upstream.headers.get(key);
      if (value !== null) responseHeaders.set(key, value);
    }
    const isSse = upstream.headers.get("content-type")?.toLowerCase().startsWith("text/event-stream") ?? false;
    if (isSse) {
      const cacheControl = responseHeaders.get("cache-control");
      responseHeaders.set("cache-control", cacheControl ? `${cacheControl}, no-transform` : "no-transform");
    }
    if (!isSse && Number(upstream.headers.get("content-length")) > MAX_RESPONSE) {
      abort.abort();
      await agent.destroy();
      return deny(upstreamError("too_large"));
    }
    status = upstream.status;
    if (!upstream.body) {
      await agent.destroy();
      log();
      return new Response(null, { status, headers: responseHeaders });
    }
    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let sseBuffer = "";
    let initialEvent: Uint8Array | undefined;
    let oversizedFirstEvent = false;
    let eventLine = "";
    let eventLineTruncated = false;
    let eventType = "message";
    const scanEvent = (text: string) => {
      for (const character of text) {
        if (character === "\n") {
          if (!eventLineTruncated && eventLine.startsWith("event:")) eventType = eventLine.slice(6).trim();
          eventLine = "";
          eventLineTruncated = false;
        } else if (eventLine.length < 256) {
          eventLine += character;
        } else {
          eventLineTruncated = true;
        }
      }
    };
    const inspectFirstEvent = isSse && request.method === "GET" && !request.headers.has("mcp-session-id");
    if (inspectFirstEvent) {
      try {
        for (;;) {
          const boundary = /\r?\n\r?\n/.exec(sseBuffer);
          if (boundary) {
            const event = sseBuffer.slice(0, boundary.index);
            sseBuffer = sseBuffer.slice(boundary.index + boundary[0].length);
            if (event.split(/\r?\n/).every((line) => line === "" || line.startsWith(":"))) continue;
            try { initialEvent = encoder.encode(`${rewriteEndpointEvent(event, original, id)}\n\n`); }
            catch { throw new SafeFetchError("redirect"); }
            break;
          }
          if (sseBuffer.length > 16_384) {
            oversizedFirstEvent = true;
            const prefix = sseBuffer.slice(0, -4);
            scanEvent(prefix);
            initialEvent = encoder.encode(prefix);
            sseBuffer = sseBuffer.slice(-4);
            break;
          }
          let timer: ReturnType<typeof setTimeout> | undefined;
          const idle = new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new SafeFetchError("timeout")), 300_000);
          });
          let part: Awaited<ReturnType<typeof reader.read>>;
          try { part = await Promise.race([reader.read(), idle]); }
          finally { if (timer) clearTimeout(timer); }
          if (part.done) break;
          bytes += part.value.byteLength;
          sseBuffer += decoder.decode(part.value, { stream: true });
        }
      } catch (error) {
        abort.abort();
        await agent.destroy();
        return deny(upstreamError(classifySafeFetchError(error).reason));
      }
    }
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          if (initialEvent) {
            controller.enqueue(initialEvent);
            initialEvent = undefined;
            return;
          }
          if (inspectFirstEvent && sseBuffer && !oversizedFirstEvent) {
            controller.enqueue(encoder.encode(sseBuffer));
            sseBuffer = "";
            return;
          }
          const idle = new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("stream idle")), 300_000);
          });
          const result = await Promise.race([reader.read(), idle]);
          if (result.done) {
            if (inspectFirstEvent) {
              let remaining = sseBuffer + decoder.decode();
              if (oversizedFirstEvent) {
                scanEvent(`${remaining}\n`);
                if (eventType === "endpoint") remaining += "\nevent: message\n\n";
              }
              sseBuffer = "";
              if (remaining) controller.enqueue(encoder.encode(remaining));
            }
            controller.close();
            log();
            await agent.destroy();
            return;
          }
          bytes += result.value.byteLength;
          if (!isSse && bytes > MAX_RESPONSE) throw new SafeFetchError("too_large");
          if (inspectFirstEvent) {
            const text = decoder.decode(result.value, { stream: true });
            if (oversizedFirstEvent) {
              sseBuffer += text;
              const boundary = /\r?\n\r?\n/.exec(sseBuffer);
              if (boundary) {
                const prefix = sseBuffer.slice(0, boundary.index);
                scanEvent(`${prefix}\n`);
                const suffix = eventType === "endpoint" ? "\nevent: message" : "";
                controller.enqueue(encoder.encode(`${prefix}${suffix}${boundary[0]}`));
                sseBuffer = sseBuffer.slice(boundary.index + boundary[0].length);
                oversizedFirstEvent = false;
              } else if (sseBuffer.length > 4) {
                const prefix = sseBuffer.slice(0, -4);
                scanEvent(prefix);
                controller.enqueue(encoder.encode(prefix));
                sseBuffer = sseBuffer.slice(-4);
              }
            } else if (text) controller.enqueue(encoder.encode(text));
          } else {
            controller.enqueue(result.value);
          }
        } catch (error) {
          abort.abort();
          controller.error(error);
          log();
          await agent.destroy();
        } finally { if (timer) clearTimeout(timer); }
      },
      async cancel() {
        abort.abort();
        await reader.cancel().catch(() => {});
        log();
        await agent.destroy();
      },
    });
    return new Response(stream, { status, headers: responseHeaders });
  } catch (error) {
    clearTimeout(deadline);
    abort.abort();
    await agent.destroy();
    const reason = classifySafeFetchError(error).reason;
    return deny(upstreamError(reason === "dns_not_found" ? "dns" : reason === "connect_failed" ? "unreachable" : reason));
  }
}
