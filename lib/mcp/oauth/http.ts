import { hostPort, parseOutboundUrl } from "@/lib/web/public-url";
import { checkOutboundAddress, safeFetch, type SafeFetchInit, type SafeFetchResult } from "@/lib/web/safe-fetch";
import { mcpPolicy } from "../policy";

function oauthPolicy() {
  return { ...mcpPolicy(10_000), maxBytes: 1024 * 1024 };
}

/** Every endpoint, including the browser-only authorization endpoint, uses the shared SSRF policy. */
export async function validateOAuthEndpoint(input: string, signal?: AbortSignal): Promise<string> {
  const policy = oauthPolicy();
  const parsed = parseOutboundUrl(input, policy);
  if (!parsed.ok || parsed.url.hash || (
    parsed.url.protocol !== "https:" && !policy.allowHosts?.includes(hostPort(parsed.url))
  )) throw new Error("Недопустимый адрес OAuth");
  return (await checkOutboundAddress(input, policy, signal)).href;
}

export async function oauthFetch(url: string, init: SafeFetchInit = {}, firstChunkOnly = false): Promise<SafeFetchResult> {
  const deadline = AbortSignal.timeout(10_000);
  const signal = init.signal ? AbortSignal.any([init.signal, deadline]) : deadline;
  return safeFetch(await validateOAuthEndpoint(url, signal), { ...init, signal }, {
    ...oauthPolicy(), ...(firstChunkOnly ? { stopAfter: () => true } : {}),
  });
}

export function jsonObject(response: SafeFetchResult): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(response.body.toString("utf8"));
    if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch {
    // Provider bodies can contain codes and tokens; never attach them to an exception.
  }
  throw new Error("Некорректный ответ OAuth");
}
