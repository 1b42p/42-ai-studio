export type McpCredentials =
  | { authKind: "none"; credentials: null }
  | { authKind: "oauth"; credentials: null }
  | { authKind: "bearer"; credentials: { token: string } }
  | { authKind: "headers"; credentials: { headers: Record<string, string> } };

export class McpValidationError extends Error {}

const FORBIDDEN_HEADERS = new Set([
  "host", "content-length", "content-type", "transfer-encoding", "connection",
  "upgrade", "te", "trailer", "keep-alive", "proxy-authorization",
  "proxy-connection", "cookie", "set-cookie", "accept", "accept-encoding",
  "origin", "referer", "mcp-session-id", "mcp-protocol-version", "last-event-id",
]);

export function parseMcpCredentials(input: Record<string, unknown>): McpCredentials {
  if (input.authKind === "none") return { authKind: "none", credentials: null };
  if (input.authKind === "oauth") {
    if (Object.hasOwn(input, "token") || Object.hasOwn(input, "headers")) {
      throw new McpValidationError("Для входа через браузер токен и заголовки не нужны.");
    }
    return { authKind: "oauth", credentials: null };
  }
  if (input.authKind === "bearer") {
    if (typeof input.token !== "string" || input.token.length < 1 || input.token.length > 4096 ||
        /[\s\p{Cc}]/u.test(input.token)) {
      throw new McpValidationError("Укажите токен.");
    }
    return { authKind: "bearer", credentials: { token: input.token } };
  }
  if (input.authKind === "headers") {
    if (!Array.isArray(input.headers) || input.headers.length < 1 || input.headers.length > 10) {
      throw new McpValidationError("Укажите хотя бы один заголовок (не больше 10).");
    }
    const headers: Record<string, string> = Object.create(null);
    for (const item of input.headers) {
      const name = typeof item?.name === "string" ? item.name : "";
      const value = typeof item?.value === "string" ? item.value : null;
      const key = name.toLowerCase();
      if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,64}$/.test(name) ||
          FORBIDDEN_HEADERS.has(key) || key.startsWith("x-studio-") || key.startsWith("sec-") ||
          Object.hasOwn(headers, key) || value === null || value.length > 2048 || /[\p{Cc}]/u.test(value)) {
        throw new McpValidationError(`Заголовок «${name}» использовать нельзя.`);
      }
      headers[key] = value;
    }
    return { authKind: "headers", credentials: { headers } };
  }
  throw new McpValidationError("Выберите способ авторизации.");
}
