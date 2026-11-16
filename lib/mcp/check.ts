import { decryptSecret } from "@/lib/secrets";
import { loadConfig } from "@/lib/config";
import { fetch } from "undici";

import { checkOutboundAddress, classifySafeFetchError, createSafeAgent, safeFetch, SafeFetchError } from "@/lib/web/safe-fetch";
import type { mcpServers } from "@/lib/db/schema";

import { mcpPolicy, validateMcpAddress } from "./policy";
import { McpValidationError } from "./credentials";

type Server = typeof mcpServers.$inferSelect;
type Reason = "blocked_address" | "dns" | "unreachable" | "timeout" | "redirect" | "unauthorized" | "forbidden" | "not_mcp" | "too_large" | "tls";

const MESSAGES: Record<Reason, string> = {
  blocked_address: "Адрес сервера указывает во внутреннюю сеть. Подключение запрещено.",
  dns: "Имя сервера не найдено.",
  unreachable: "Сервер недоступен.",
  timeout: "Сервер не ответил за 15 секунд.",
  redirect: "Сервер перенаправляет запросы. Укажите конечный адрес.",
  unauthorized: "Сервер отказал в доступе. Проверьте токен или заголовки.",
  forbidden: "Доступ запрещён сервером.",
  not_mcp: "Ответ не похож на ответ MCP-сервера.",
  too_large: "Ответ сервера слишком большой.",
  tls: "Не удалось проверить сертификат сервера.",
};

export function serverHeaders(server: Server): Record<string, string> {
  const headers: Record<string, string> = Object.create(null);
  if (server.credentialsEncrypted) {
    const credentials = JSON.parse(decryptSecret(server.credentialsEncrypted, loadConfig().secretsEncryptionKey, `mcp-server:${server.id}`));
    if (server.authKind === "bearer") headers.authorization = `Bearer ${credentials.token}`;
    if (server.authKind === "headers") Object.assign(headers, credentials.headers);
  }
  headers["user-agent"] = "42-ai-studio-mcp/1";
  headers["accept-encoding"] = "identity";
  return headers;
}

class CheckFailure extends Error {
  constructor(readonly reason: Reason, readonly redirectHost?: string) { super(reason); }
}

async function checkLegacyMcp(server: Server, headers: Record<string, string>, signal: AbortSignal) {
  const policy = mcpPolicy(15_000);
  const original = await checkOutboundAddress(server.url, policy, signal);
  const agent = createSafeAgent(policy);
  try {
    const response = await fetch(original, {
      method: "GET", headers: { ...headers, accept: "text/event-stream" },
      redirect: "manual", dispatcher: agent, signal,
    });
    if (response.status === 401) throw new CheckFailure("unauthorized");
    if (response.status === 403) throw new CheckFailure("forbidden");
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      throw new CheckFailure("redirect", location ? URL.parse(location, original)?.hostname : undefined);
    }
    if (!response.ok || !response.headers.get("content-type")?.includes("text/event-stream") || !response.body) {
      throw new CheckFailure("not_mcp");
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const event = async () => {
      for (;;) {
        const boundary = /\r?\n\r?\n/.exec(buffer);
        if (boundary) {
          const block = buffer.slice(0, boundary.index);
          buffer = buffer.slice(boundary.index + boundary[0].length);
          const lines = block.split(/\r?\n/);
          return {
            kind: lines.find((line) => line.startsWith("event:"))?.slice(6).trim() ?? "message",
            data: lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).replace(/^ /, "")).join("\n"),
          };
        }
        const part = await reader.read();
        if (part.done) throw new CheckFailure("not_mcp");
        buffer += decoder.decode(part.value, { stream: true });
        if (Buffer.byteLength(buffer) > policy.maxBytes) throw new CheckFailure("too_large");
      }
    };
    try {
      let endpointEvent = await event();
      while (endpointEvent.kind === "message" && endpointEvent.data === "") endpointEvent = await event();
      if (endpointEvent.kind !== "endpoint") throw new CheckFailure("not_mcp");
      let endpoint: URL;
      try { endpoint = new URL(endpointEvent.data, original); }
      catch { throw new CheckFailure("not_mcp"); }
      if (endpoint.origin !== original.origin) throw new CheckFailure("redirect", endpoint.hostname);
      const send = async (message: Record<string, unknown>) => {
        const sent = await safeFetch(endpoint.href, {
          method: "POST", headers: { ...headers, accept: "application/json, text/event-stream", "content-type": "application/json" },
          body: JSON.stringify(message), signal,
        }, policy);
        if (sent.status === 401) throw new CheckFailure("unauthorized");
        if (sent.status === 403) throw new CheckFailure("forbidden");
        if (sent.status >= 400) throw new CheckFailure("not_mcp");
        if (message.id === undefined) return undefined;
        for (;;) {
          const received = await event();
          if (received.kind !== "message" || received.data === "") continue;
          let value;
          try { value = JSON.parse(received.data); } catch { throw new CheckFailure("not_mcp"); }
          if (value.id !== message.id) continue;
          if (value.jsonrpc !== "2.0" || !value.result || value.error) throw new CheckFailure("not_mcp");
          return value.result;
        }
      };
      const initialized = await send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
        protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "42-ai-studio", version: "1" },
      } });
      if (typeof initialized?.protocolVersion !== "string") throw new CheckFailure("not_mcp");
      await send({ jsonrpc: "2.0", method: "notifications/initialized" });
      const result = await send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
      if (!Array.isArray(result?.tools)) throw new CheckFailure("not_mcp");
      return {
        ok: true as const, toolCount: result.tools.length,
        tools: result.tools.map((tool: { name?: unknown }) => tool.name).filter((name: unknown): name is string => typeof name === "string").slice(0, 50),
      };
    } finally {
      await reader.cancel().catch(() => {});
    }
  } finally {
    await agent.destroy();
  }
}

export async function checkMcpServer(server: Server) {
  const signal = AbortSignal.timeout(15_000);
  let authenticationHeaders: Record<string, string>;
  try { authenticationHeaders = serverHeaders(server); }
  catch { return { ok: false as const, reason: "unreachable" as const, message: MESSAGES.unreachable }; }
  const headers = {
    ...authenticationHeaders, accept: "application/json, text/event-stream",
    "content-type": "application/json",
  };
  let sessionId: string | undefined;
  let protocolVersion: string | undefined;
  const send = async (message: object, allowFallback = false) => {
    const messageId = "id" in message ? message.id : undefined;
    const result = await safeFetch(server.url, {
      method: "POST",
      headers: {
        ...headers,
        ...(sessionId ? { "mcp-session-id": sessionId } : {}),
        ...(protocolVersion ? { "mcp-protocol-version": protocolVersion } : {}),
      },
      body: JSON.stringify(message), signal,
    }, {
      ...mcpPolicy(15_000),
      stopAfter: (body, responseHeaders) => {
        if (messageId === undefined || !responseHeaders.get("content-type")?.includes("text/event-stream")) return false;
        return body.toString("utf8").split(/\r?\n\r?\n/).slice(0, -1).some((event) => {
          const data = event.split(/\r?\n/).filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).replace(/^ /, "")).join("\n");
          try { const parsed = JSON.parse(data); return parsed.jsonrpc === "2.0" && parsed.id === messageId; }
          catch { return false; }
        });
      },
    });
    if (result.status === 401) throw new CheckFailure("unauthorized");
    if (result.status === 403) throw new CheckFailure("forbidden");
    if (result.status >= 400 && !(allowFallback && [400, 404, 405].includes(result.status))) throw new CheckFailure("not_mcp");
    sessionId ??= result.headers.get("mcp-session-id") ?? undefined;
    return result;
  };
  const parseResult = (result: Awaited<ReturnType<typeof send>>, id: number) => {
    const type = result.headers.get("content-type") ?? "";
    const text = result.body.toString("utf8");
    let json = text;
    if (type.includes("text/event-stream")) {
      json = text.split(/\r?\n\r?\n/).map((event) =>
        event.split(/\r?\n/).filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).replace(/^ /, "")).join("\n"),
      ).find((data) => {
        try { return JSON.parse(data).id === id; } catch { return false; }
      }) ?? "";
    } else if (!type.includes("application/json")) throw new CheckFailure("not_mcp");
    try {
      const value = JSON.parse(json);
      if (value?.jsonrpc !== "2.0" || value.id !== id || !value.result || value.error) throw new CheckFailure("not_mcp");
      return value.result;
    } catch { throw new CheckFailure("not_mcp"); }
  };
  try {
    await validateMcpAddress(server.url, server.authKind, signal);
    const init = await send({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "42-ai-studio", version: "1" } },
    }, true);
    if ([400, 404, 405].includes(init.status)) return await checkLegacyMcp(server, headers, signal);
    const initialized = parseResult(init, 1);
    if (typeof initialized.protocolVersion !== "string" || !initialized.protocolVersion) throw new CheckFailure("not_mcp");
    protocolVersion = initialized.protocolVersion;
    await send({ jsonrpc: "2.0", method: "notifications/initialized" });
    const toolsResult = parseResult(await send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }), 2);
    if (!Array.isArray(toolsResult.tools)) throw new CheckFailure("not_mcp");
    const names = toolsResult.tools.map((tool: { name?: unknown }) => tool.name).filter((name: unknown): name is string => typeof name === "string");
    return { ok: true as const, toolCount: toolsResult.tools.length, tools: names.slice(0, 50) };
  } catch (error) {
    let reason: Reason = "unreachable";
    if (error instanceof CheckFailure) reason = error.reason;
    else if (error instanceof McpValidationError) reason = "blocked_address";
    else if (signal.aborted) reason = "timeout";
    else {
      const outbound = classifySafeFetchError(error);
      const map: Partial<Record<SafeFetchError["reason"], Reason>> = {
        blocked_address: "blocked_address", dns_not_found: "dns", connect_failed: "unreachable",
        timeout: "timeout", redirect: "redirect", too_large: "too_large", tls: "tls",
      };
      reason = map[outbound.reason] ?? "unreachable";
    }
    const redirectHost = error instanceof SafeFetchError || error instanceof CheckFailure ? error.redirectHost : undefined;
    const message = reason === "redirect" && redirectHost
      ? `Сервер перенаправляет запросы на ${redirectHost}. Укажите конечный адрес.`
      : MESSAGES[reason];
    return { ok: false as const, reason, message };
  } finally {
    if (sessionId && !signal.aborted) {
      await safeFetch(server.url, { method: "DELETE", headers: { ...headers, "mcp-session-id": sessionId, ...(protocolVersion ? { "mcp-protocol-version": protocolVersion } : {}) }, signal }, mcpPolicy(15_000)).catch(() => {});
    }
  }
}
