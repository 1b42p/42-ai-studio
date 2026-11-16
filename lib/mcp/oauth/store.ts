import { and, eq, getTableColumns, isNull, sql } from "drizzle-orm";
import type { ConnectionPrincipal } from "eve/connections";

import { loadConfig } from "@/lib/config";
import { getDb, getLockSqlClient } from "@/lib/db/client";
import { mcpServers, users } from "@/lib/db/schema";
import { decryptSecret, encryptSecret } from "@/lib/secrets";

import { authorizationFailure } from "./errors";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function assertStudioPrincipal(principal: ConnectionPrincipal, connection: string): asserts principal is Extract<ConnectionPrincipal, { type: "user" }> {
  if (principal.type !== "user" || principal.issuer !== "studio" || !uuid.test(principal.id)) {
    throw authorizationFailure(connection, "wrong_user");
  }
}

export async function readOAuthServer(id: string) {
  if (!uuid.test(id)) return undefined;
  const [server] = await getDb().select({
    ...getTableColumns(mcpServers),
    revision: sql<string>`${mcpServers}.xmin::text`,
  }).from(mcpServers).where(eq(mcpServers.id, id)).limit(1);
  return server;
}

export type OAuthServer = NonNullable<Awaited<ReturnType<typeof readOAuthServer>>>;

export async function ownedOAuthServer(id: string, principal: ConnectionPrincipal, connection = id): Promise<OAuthServer> {
  assertStudioPrincipal(principal, connection);
  const server = await readOAuthServer(id);
  if (!server || server.userId !== principal.id || server.authKind !== "oauth" || !server.enabled) {
    throw authorizationFailure(connection, "wrong_user");
  }
  const [owner] = await getDb().select({ id: users.id }).from(users).where(and(
    eq(users.id, principal.id), eq(users.isBlocked, false), isNull(users.deletionRequestedAt),
  )).limit(1);
  if (!owner) throw authorizationFailure(connection, "wrong_user");
  return server;
}

export function sealOAuthValue(serverId: string, purpose: "credentials" | "flow", value: unknown): string {
  return encryptSecret(JSON.stringify(value), loadConfig().secretsEncryptionKey,
    purpose === "flow" ? `mcp-oauth-flow:${serverId}` : `mcp-server:${serverId}`);
}

export function openOAuthValue(serverId: string, purpose: "credentials" | "flow", encrypted: string): unknown {
  return JSON.parse(decryptSecret(encrypted, loadConfig().secretsEncryptionKey,
    purpose === "flow" ? `mcp-oauth-flow:${serverId}` : `mcp-server:${serverId}`));
}

/** xmin is an opaque row revision; unlike JS dates it keeps PostgreSQL's full precision. */
export async function compareAndSetCredentials(server: OAuthServer, encrypted: string | null): Promise<boolean> {
  const changed = await getDb().update(mcpServers).set({
    credentialsEncrypted: encrypted, updatedAt: sql`clock_timestamp()`,
  }).where(and(
    eq(mcpServers.id, server.id), eq(mcpServers.userId, server.userId),
    eq(mcpServers.authKind, "oauth"), eq(mcpServers.enabled, true),
    sql`${mcpServers}.xmin::text = ${server.revision}`,
    sql`exists (select 1 from ${users} where ${users.id} = ${server.userId} and not ${users.isBlocked} and ${users.deletionRequestedAt} is null)`,
  )).returning({ id: mcpServers.id });
  return changed.length === 1;
}

/** Dedicated pool: waiting refreshes must not exhaust the normal query pool. */
export async function withOAuthLock<T>(serverId: string, run: () => Promise<T>): Promise<T> {
  if (!uuid.test(serverId)) throw authorizationFailure(serverId, "wrong_user");
  const connection = await getLockSqlClient().reserve();
  let locked = false;
  try {
    await connection`select pg_advisory_lock(3, hashtext(${serverId}::text))`;
    locked = true;
    return await run();
  } finally {
    try {
      if (locked) await connection`select pg_advisory_unlock(3, hashtext(${serverId}::text))`;
    } finally {
      connection.release();
    }
  }
}

/** Also updates an already-empty row: pending callbacks must not resurrect a signed-out grant. */
export async function clearOAuthServer(id: string) {
  await getDb().update(mcpServers).set({
    credentialsEncrypted: null, updatedAt: sql`clock_timestamp()`,
  }).where(and(eq(mcpServers.id, id), eq(mcpServers.authKind, "oauth")));
}

/** Caller holds the OAuth lock continuously from reading/revoking the grant through this deletion. */
export async function deleteOwnedOAuthServerRow(id: string, userId: string): Promise<boolean> {
  const deleted = await getDb().delete(mcpServers).where(and(
    eq(mcpServers.id, id), eq(mcpServers.userId, userId), eq(mcpServers.authKind, "oauth"),
  )).returning({ id: mcpServers.id });
  return deleted.length === 1;
}
