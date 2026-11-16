import { createHash, timingSafeEqual } from "node:crypto";

export const TOKEN_EXPIRY_MARGIN_MS = 60_000;
export type TokenEndpointAuthMethod = "none" | "client_secret_basic" | "client_secret_post";

export function canonicalResource(input: string): string {
  const url = new URL(input);
  return `${url.origin}${url.pathname === "/" ? "" : url.pathname}`;
}

/** Split only outside quoted strings: commas are legal inside auth-param values. */
export function parseBearerChallenge(header: string | null): Record<string, string> {
  const chunks = (header ?? "").match(/(?:[^,"\\]|\\.|"(?:[^"\\]|\\.)*")+/g) ?? [];
  const result: Record<string, string> = {};
  let bearer = false;
  for (const chunk of chunks) {
    let value = chunk.trim();
    const scheme = /^([!#$%&'*+.^_`|~\w-]+)(?:[ \t]+(.*)|$)/.exec(value);
    if (scheme && !/^\s*=/.test(scheme[2] ?? "")) {
      if (bearer) break;
      bearer = scheme[1].toLowerCase() === "bearer";
      value = scheme[2] ?? "";
    }
    if (!bearer) continue;
    const param = /^([!#$%&'*+.^_`|~\w-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s]+))\s*$/.exec(value);
    if (param) {
      const key = param[1].toLowerCase();
      // Duplicate security parameters are ambiguous, not a reason to pick one.
      if (Object.hasOwn(result, key)) throw new Error("Неоднозначный запрос авторизации");
      result[key] = param[2] === undefined ? param[3] : param[2].replace(/\\(.)/g, "$1");
    }
  }
  return result;
}

export function authorizationMetadataUrls(issuer: string): string[] {
  const url = new URL(issuer);
  if (url.search || url.hash) throw new Error("Некорректный издатель");
  const path = url.pathname.replace(/\/$/, "");
  return [
    `${url.origin}/.well-known/oauth-authorization-server${path}`,
    `${url.origin}/.well-known/openid-configuration${path}`,
    ...(path ? [`${url.origin}${path}/.well-known/openid-configuration`] : []),
  ];
}

export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

export function tokenIsUsable(expiresAt: number | null, now = Date.now(), marginMs = TOKEN_EXPIRY_MARGIN_MS): boolean {
  return expiresAt === null || expiresAt - now > marginMs;
}

export function expiresAtFromSeconds(value: unknown, now = Date.now()): number | null {
  if (value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 ||
      !Number.isSafeInteger(now + value * 1000)) throw new Error("Некорректный срок токена");
  return now + value * 1000;
}

export function validIssuerResponse(issuer: string, required: boolean, returned: string | undefined): boolean {
  return returned === undefined ? !required : returned === issuer;
}

export function equalState(expected: string, returned: string | undefined): boolean {
  const a = createHash("sha256").update(expected).digest();
  const b = createHash("sha256").update(returned ?? "").digest();
  return typeof returned === "string" && timingSafeEqual(a, b);
}

export function publicCallbackUrl(callbackUrl: string, appUrl: string): string {
  const callback = new URL(callbackUrl);
  const result = new URL(appUrl);
  result.pathname = callback.pathname;
  result.search = callback.search;
  result.hash = "";
  return result.href;
}

export function buildAuthorizationUrl(endpoint: string, input: {
  clientId: string; redirectUri: string; state: string; verifier: string; resource: string; scope: string;
}): string {
  const url = new URL(endpoint);
  for (const [key, value] of Object.entries({
    response_type: "code", client_id: input.clientId, redirect_uri: input.redirectUri,
    state: input.state, code_challenge: pkceChallenge(input.verifier),
    code_challenge_method: "S256", resource: input.resource,
  })) url.searchParams.set(key, value);
  if (input.scope) url.searchParams.set("scope", input.scope);
  else url.searchParams.delete("scope");
  return url.href;
}

/** RFC 6749 §2.3.1: form-encode both halves before building HTTP Basic. */
export function authenticateClient(form: URLSearchParams, client: {
  clientId: string; clientSecret: string | null; tokenEndpointAuthMethod: TokenEndpointAuthMethod;
}): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" };
  form.set("client_id", client.clientId);
  if (client.tokenEndpointAuthMethod !== "none") {
    if (!client.clientSecret) throw new Error("Отсутствует секрет клиента");
    if (client.tokenEndpointAuthMethod === "client_secret_post") form.set("client_secret", client.clientSecret);
    else {
      const encode = (value: string) => new URLSearchParams({ x: value }).toString().slice(2);
      headers.Authorization = `Basic ${Buffer.from(`${encode(client.clientId)}:${encode(client.clientSecret)}`).toString("base64")}`;
    }
  }
  return headers;
}
