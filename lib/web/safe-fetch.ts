import { lookup } from "node:dns/promises";
import { isIP, type LookupFunction } from "node:net";
import { Agent, Pool, fetch, Headers, type RequestInit } from "undici";

import { hostPort, isBlockedIp, parseOutboundUrl, type UrlPolicy } from "./public-url";

export { isBlockedIp, parseOutboundUrl } from "./public-url";

export type SafeFetchReason =
  | "bad_url" | "blocked_address" | "dns_not_found" | "redirect"
  | "too_many_redirects" | "redirect_loop" | "connect_failed" | "tls"
  | "timeout" | "too_large";

export class SafeFetchError extends Error {
  constructor(readonly reason: SafeFetchReason) {
    super(reason);
    this.name = "SafeFetchError";
  }
}

export interface OutboundPolicy extends UrlPolicy {
  maxRedirects: number;
  timeoutMs: number;
  maxBytes: number;
  resolveDns?: (hostname: string) => Promise<readonly string[]>;
}

export interface SafeFetchResult {
  finalUrl: string;
  redirects: number;
  status: number;
  headers: Headers;
  /** Полное тело после распаковки, ограниченное policy.maxBytes. */
  body: Buffer;
}

export type SafeFetchInit = Pick<RequestInit, "method" | "headers" | "body" | "signal">;

function acceptUrl(input: string, policy: UrlPolicy): URL {
  const result = parseOutboundUrl(input, policy);
  if (!result.ok) throw new SafeFetchError(result.reason);
  result.url.hash = "";
  return result.url;
}

function bareHost(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

async function resolveHost(url: URL, policy: OutboundPolicy): Promise<{ address: string; family: 4 | 6 }[]> {
  const host = bareHost(url);
  let ips: readonly string[];
  try {
    ips = isIP(host) ? [host] : policy.resolveDns
      ? await policy.resolveDns(host)
      : (await lookup(host, { all: true, order: "verbatim" })).map(({ address }) => address);
  } catch {
    throw new SafeFetchError("dns_not_found");
  }
  if (!ips.length) throw new SafeFetchError("dns_not_found");
  const allowed = policy.allowHosts?.includes(hostPort(url));
  if (ips.some((ip) => !isIP(ip) || (!allowed && isBlockedIp(ip)))) {
    throw new SafeFetchError("blocked_address");
  }
  return ips.map((address) => ({ address, family: isIP(address) as 4 | 6 }));
}

/** Прерывает в том числе предварительное DNS-разрешение, у lookup нет AbortSignal. */
function withSignal<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener("abort", aborted, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
  });
}

export function createSafeAgent(policy: OutboundPolicy): Agent {
  return new Agent({
    factory(origin, options) {
      const url = acceptUrl(String(origin), policy);
      const guardedLookup: LookupFunction = (hostname, lookupOptions, callback) => {
        const target = new URL(url);
        target.hostname = hostname;
        const timer = AbortSignal.timeout(Math.min(10_000, policy.timeoutMs));
        void withSignal(resolveHost(acceptUrl(target.href, policy), policy), timer).then(
          (addresses) => {
            if (lookupOptions.all) callback(null, addresses);
            else callback(null, addresses[0].address, addresses[0].family);
          },
          (error: unknown) => callback(classifyError(error), "", 4),
        );
      };
      return new Pool(origin, {
        ...options,
        connect: { lookup: guardedLookup, timeout: Math.min(10_000, policy.timeoutMs), rejectUnauthorized: true },
      });
    },
  });
}

function classifyError(error: unknown): SafeFetchError {
  if (error instanceof SafeFetchError) return error;
  if (error instanceof Error) {
    if (error.cause) return classifyError(error.cause);
    if (error instanceof AggregateError) {
      const failures = error.errors.map(classifyError);
      return failures.find((failure) => failure.reason !== "connect_failed") ?? new SafeFetchError("connect_failed");
    }
    const code = "code" in error ? String(error.code) : error.name;
    if (/CERT|TLS|SSL|UNABLE_TO_VERIFY|SELF_SIGNED/.test(code)) return new SafeFetchError("tls");
    if (/TIMEOUT|TimeoutError/.test(code)) return new SafeFetchError("timeout");
  }
  return new SafeFetchError("connect_failed");
}

/** Все адреса, DNS-ответы и соединения проверяются одной политикой, без глобального dispatcher. */
export async function safeFetch(input: string, init: SafeFetchInit, policy: OutboundPolicy): Promise<SafeFetchResult> {
  let current = acceptUrl(input, policy);
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(new SafeFetchError("timeout")), policy.timeoutMs);
  const signal = init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal;
  const agent = createSafeAgent(policy);
  const seen = new Set<string>();
  let redirects = 0;
  let method = init.method ?? "GET";
  let body = init.body;
  const headers = new Headers(init.headers);
  try {
    for (;;) {
      signal.throwIfAborted();
      if (seen.has(current.href)) throw new SafeFetchError("redirect_loop");
      seen.add(current.href);
      await withSignal(resolveHost(current, policy), signal);
      const started = performance.now();
      const response = await fetch(current, {
        method, body, headers, signal, redirect: "manual", dispatcher: agent,
      });
      let bytes = 0;
      try {
        if (response.status >= 300 && response.status < 400) {
          if (policy.maxRedirects === 0) throw new SafeFetchError("redirect");
          if ([301, 302, 303, 307, 308].includes(response.status)) {
            if (++redirects > policy.maxRedirects) throw new SafeFetchError("too_many_redirects");
            const location = response.headers.get("location");
            if (!location) throw new SafeFetchError("redirect");
            let next: string;
            try { next = new URL(location, current).href; }
            catch { throw new SafeFetchError("bad_url"); }
            current = acceptUrl(next, policy);
            for (const name of ["cookie", "authorization", "proxy-authorization", "referer", "host", "content-type", "content-length"]) headers.delete(name);
            method = "GET";
            body = undefined;
            continue;
          }
        }
        const chunks: Uint8Array[] = [];
        if (response.body) {
          for await (const chunk of response.body) {
            bytes += chunk.byteLength;
            if (bytes > policy.maxBytes) throw new SafeFetchError("too_large");
            chunks.push(chunk);
          }
        }
        return { finalUrl: current.href, redirects, status: response.status, headers: response.headers, body: Buffer.concat(chunks, bytes) };
      } finally {
        await response.body?.cancel().catch(() => {});
        console.info("[safe-fetch]", { host: response.url ? new URL(response.url).hostname : current.hostname, status: response.status, bytes, durationMs: Math.round(performance.now() - started) });
      }
    }
  } catch (error) {
    throw classifyError(error);
  } finally {
    clearTimeout(deadline);
    controller.abort();
    await agent.destroy();
  }
}
