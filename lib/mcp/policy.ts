import { loadConfig } from "@/lib/config";
import { checkOutboundAddress, SafeFetchError, type OutboundPolicy } from "@/lib/web/safe-fetch";
import { hostPort, parseOutboundUrl } from "@/lib/web/public-url";

import { McpValidationError } from "./credentials";

export function mcpPolicy(timeoutMs = 30_000): OutboundPolicy {
  return {
    schemes: ["http:", "https:"],
    ports: "any",
    maxRedirects: 0,
    timeoutMs,
    maxBytes: 16 * 1024 * 1024,
    allowHosts: loadConfig().ssrfTestAllowHosts,
    suppressLog: true,
  };
}

export async function validateMcpAddress(input: string, authKind: string, signal?: AbortSignal): Promise<URL> {
  const policy = mcpPolicy();
  const parsed = parseOutboundUrl(input, policy);
  if (!parsed.ok) throw new SafeFetchError(parsed.reason);
  const url = parsed.url;
  if (url.protocol !== "https:" && authKind !== "none" && !policy.allowHosts?.includes(hostPort(url))) {
    throw new McpValidationError("Авторизация доступна только по https.");
  }
  await checkOutboundAddress(url.href, policy, signal);
  url.hash = "";
  return url;
}
