/**
 * Разбор адреса перед исходящим запросом. Проверки имени и IP выполняются
 * до соединения: внутренняя сеть, метаданные облака и нестандартные схемы
 * не получают запроса.
 */
import { BlockList, isIP } from "node:net";

const blockedV4 = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blockedV4.addSubnet(address, prefix, "ipv4");
}

/** Всё, кроме глобальных одноадресных 2000::/3, и исключения внутри этого блока. */
const blockedV6 = new BlockList();
for (const [address, prefix] of [
  ["::", 3],
  ["4000::", 2],
  ["8000::", 1],
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
] as const) {
  blockedV6.addSubnet(address, prefix, "ipv6");
}

const BLOCKED_SUFFIXES = [
  ".localhost",
  ".local",
  ".localdomain",
  ".internal",
  ".intranet",
  ".lan",
  ".home.arpa",
  ".corp",
  ".home",
];

export type UrlRejectReason = "bad_url" | "blocked_address";

export interface UrlPolicy {
  schemes: readonly ("http:" | "https:")[];
  ports: "web" | "any";
  /** Точное исключение «хост:порт» для локального сервера тестов. */
  allowHosts?: readonly string[];
}

export function hostPort(url: URL): string {
  return `${url.hostname}:${url.port || (url.protocol === "https:" ? "443" : "80")}`;
}

export function isBlockedIp(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return blockedV4.check(ip, "ipv4");
  if (family === 6) return blockedV6.check(ip, "ipv6");
  return true;
}

function bareHost(hostname: string): string {
  let name = hostname.replace(/\.$/, "").toLowerCase();
  if (name.startsWith("[") && name.endsWith("]")) name = name.slice(1, -1);
  return name;
}

function hostnameBlocked(hostname: string): boolean {
  const name = bareHost(hostname);
  if (name === "localhost" || name === "") return true;
  if (BLOCKED_SUFFIXES.some((suffix) => name.endsWith(suffix))) return true;
  const family = isIP(name);
  if (family === 4 || family === 6) return isBlockedIp(name);
  if (!name.includes(".")) return true;
  return false;
}

/**
 * Разбирает адрес и отсекает схемы, логин, внутренние имена и IP.
 * Нестандартный порт проверяется после имени: `127.0.0.1:8080` — внутренняя сеть.
 */
export function parseOutboundUrl(
  input: string,
  policy: UrlPolicy = { schemes: ["http:", "https:"], ports: "web" },
): { ok: true; url: URL } | { ok: false; reason: UrlRejectReason } {
  if (input.length === 0 || input.length > 2048) return { ok: false, reason: "bad_url" };
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return { ok: false, reason: "bad_url" };
  }
  if (!policy.schemes.some((scheme) => scheme === url.protocol)) return { ok: false, reason: "bad_url" };
  if (url.username !== "" || url.password !== "") return { ok: false, reason: "bad_url" };
  if (url.port === "0") return { ok: false, reason: "bad_url" };
  if (policy.allowHosts?.includes(hostPort(url))) return { ok: true, url };
  if (hostnameBlocked(url.hostname)) return { ok: false, reason: "blocked_address" };
  const defaultPort = url.protocol === "https:" ? "443" : "80";
  if (policy.ports === "web" && url.port !== "" && url.port !== defaultPort) return { ok: false, reason: "bad_url" };
  return { ok: true, url };
}
