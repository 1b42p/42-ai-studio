import { randomUUID } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";

import { loadConfig } from "@/lib/config";
import { getDb } from "@/lib/db/client";
import { mcpServers, users } from "@/lib/db/schema";
import { decryptSecret, encryptSecret } from "@/lib/secrets";
import { SafeFetchError } from "@/lib/web/safe-fetch";

import { McpValidationError, parseMcpCredentials } from "./credentials";
import { validateMcpAddress } from "./policy";
import { mcpSlug } from "./slug";

type Server = typeof mcpServers.$inferSelect;

export class McpConflictError extends Error {}

export function serializeServer(server: Server) {
  const url = new URL(server.url);
  const query = url.search !== "";
  url.search = "";
  let headerNames: string[] = [];
  if (server.authKind === "headers" && server.credentialsEncrypted) {
    const credentials = JSON.parse(decryptSecret(server.credentialsEncrypted, loadConfig().secretsEncryptionKey, `mcp-server:${server.id}`));
    headerNames = Object.keys(credentials.headers);
  }
  return {
    id: server.id, name: server.name, url: `${url.href}${query ? "?…" : ""}`,
    authKind: server.authKind, enabled: server.enabled, headerNames, createdAt: server.createdAt,
  };
}

export async function listMcpServers(userId: string): Promise<Server[]> {
  return getDb().select().from(mcpServers).where(eq(mcpServers.userId, userId)).orderBy(mcpServers.createdAt);
}

export async function listEnabledMcpServers(userId: string) {
  return getDb().select({
    id: mcpServers.id, name: mcpServers.name, slug: mcpServers.slug,
    url: mcpServers.url, authKind: mcpServers.authKind,
  }).from(mcpServers).where(and(eq(mcpServers.userId, userId), eq(mcpServers.enabled, true)));
}

export async function createMcpServer(userId: string, input: Record<string, unknown>): Promise<Server> {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name || [...name].length > 60 || /[\p{Cc}]/u.test(name)) {
    throw new McpValidationError("Укажите название сервера (до 60 символов).");
  }
  const credentials = parseMcpCredentials(input);
  if (typeof input.url !== "string") {
    throw new McpValidationError("Укажите адрес сервера полностью, например https://example.com/mcp.");
  }
  let url: URL;
  try {
    url = await validateMcpAddress(input.url, credentials.authKind);
  } catch (error) {
    if (!(error instanceof SafeFetchError)) throw error;
    const message = error.reason === "blocked_address"
      ? "Адрес указывает во внутреннюю сеть или на зарезервированный адрес. Такие серверы подключать нельзя."
      : error.reason === "dns_not_found"
        ? "Имя сервера не найдено."
        : "Укажите адрес сервера полностью, например https://example.com/mcp.";
    throw new McpValidationError(message);
  }
  const id = randomUUID();
  const encrypted = credentials.credentials === null ? null : encryptSecret(
    JSON.stringify(credentials.credentials), loadConfig().secretsEncryptionKey, `mcp-server:${id}`,
  );
  const nameKey = name.normalize("NFC").toLowerCase();
  return getDb().transaction(async (tx) => {
    await tx.execute(sql`select ${users.id} from ${users} where ${users.id} = ${userId} for update`);
    const existing = await tx.select().from(mcpServers).where(eq(mcpServers.userId, userId));
    if (existing.some((server) => server.nameKey === nameKey)) throw new McpConflictError("Сервер с таким названием уже есть.");
    if (existing.some((server) => server.url === url.href)) throw new McpConflictError("Сервер с таким адресом уже подключён.");
    if (existing.length >= 10) throw new McpConflictError("Можно подключить не больше 10 серверов.");
    const base = mcpSlug(name);
    let slug = base;
    for (let suffix = 2; existing.some((server) => server.slug === slug); suffix++) slug = `${base}-${suffix}`;
    const [server] = await tx.insert(mcpServers).values({
      id, userId, name, nameKey, slug, url: url.href, authKind: credentials.authKind, credentialsEncrypted: encrypted,
    }).returning();
    return server;
  });
}

export async function findMcpServer(userId: string, id: string): Promise<Server | undefined> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return undefined;
  const [server] = await getDb().select().from(mcpServers).where(and(eq(mcpServers.userId, userId), eq(mcpServers.id, id))).limit(1);
  return server;
}
