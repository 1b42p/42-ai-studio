import { randomBytes } from "node:crypto";
import {
  ConnectionAuthorizationRequiredError,
  defineInteractiveAuthorization,
  type ConnectionPrincipal,
  type TokenResult,
} from "eve/connections";
import { z } from "zod";

import { loadConfig } from "@/lib/config";

import { discoverOAuth, registerOAuthClient } from "./discovery";
import { authorizationFailure, OAuthProtocolError } from "./errors";
import { buildAuthorizationUrl, equalState, publicCallbackUrl, tokenIsUsable, TOKEN_EXPIRY_MARGIN_MS, validIssuerResponse } from "./protocol";
import { clearOAuthServer, compareAndSetCredentials, deleteOwnedOAuthServerRow, openOAuthValue, ownedOAuthServer, readOAuthServer, sealOAuthValue, withOAuthLock, type OAuthServer } from "./store";
import { credentialsSchema, exchangeOAuthToken, InvalidRefreshGrant, revokeAtProvider, type OAuthCredentials } from "./tokens";

export { TOKEN_EXPIRY_MARGIN_MS } from "./protocol";

const flowSchema = credentialsSchema.omit({ access: true, refresh: true, expiresAt: true }).extend({
  state: z.string().min(1), verifier: z.string().min(43).max(128),
  redirectUri: z.string().min(1), issuerParameterRequired: z.boolean(),
  revision: z.string().min(1), userId: z.string().uuid(),
});

function tokenResult(credentials: Pick<OAuthCredentials, "access" | "expiresAt">): TokenResult {
  return { token: credentials.access, ...(credentials.expiresAt === null ? {} : { expiresAt: credentials.expiresAt }) };
}

function readCredentials(server: { id: string; credentialsEncrypted: string | null }): OAuthCredentials | null {
  if (!server.credentialsEncrypted) return null;
  try {
    return credentialsSchema.parse(openOAuthValue(server.id, "credentials", server.credentialsEncrypted));
  } catch {
    throw new OAuthProtocolError("token_exchange_failed");
  }
}

/**
 * Public entry point for eve and connection checks. Only studio/user owners are accepted.
 * The optional margin is a test seam, not deployment configuration.
 */
export async function getMcpOAuthToken(
  serverId: string,
  principal: ConnectionPrincipal,
  options: { expiryMarginMs?: number } = {},
): Promise<TokenResult> {
  const server = await ownedOAuthServer(serverId, principal);
  const margin = options.expiryMarginMs ?? TOKEN_EXPIRY_MARGIN_MS;
  if (options.expiryMarginMs !== undefined && (!loadConfig().appTestMode || !Number.isFinite(margin) || margin < 0)) {
    throw new Error("Запас срока OAuth можно менять только в тестовом режиме");
  }
  const credentials = readCredentials(server);
  if (!credentials) throw new ConnectionAuthorizationRequiredError(server.slug);
  if (tokenIsUsable(credentials.expiresAt, Date.now(), margin)) return tokenResult(credentials);
  return withOAuthLock(serverId, async () => {
    // Another process may have rotated the refresh token while this caller waited.
    const current = await ownedOAuthServer(serverId, principal, server.slug);
    const saved = readCredentials(current);
    if (!saved) throw new ConnectionAuthorizationRequiredError(server.slug);
    if (tokenIsUsable(saved.expiresAt, Date.now(), margin)) return tokenResult(saved);
    if (!saved.refresh) {
      await compareAndSetCredentials(current, null);
      throw new ConnectionAuthorizationRequiredError(server.slug);
    }
    try {
      const refreshed = await exchangeOAuthToken(saved.tokenEndpoint, new URLSearchParams({
        grant_type: "refresh_token", refresh_token: saved.refresh, resource: saved.resource,
      }), saved, true);
      const next: OAuthCredentials = {
        ...saved, access: refreshed.access, refresh: refreshed.refresh ?? saved.refresh,
        expiresAt: refreshed.expiresAt, scope: refreshed.scope ?? saved.scope,
      };
      if (!await compareAndSetCredentials(current, sealOAuthValue(serverId, "credentials", next))) {
        await revokeAtProvider(next);
        throw new ConnectionAuthorizationRequiredError(server.slug);
      }
      return tokenResult(next);
    } catch (error) {
      if (error instanceof InvalidRefreshGrant) {
        await compareAndSetCredentials(current, null);
        throw new ConnectionAuthorizationRequiredError(server.slug);
      }
      // Temporary network/provider errors deliberately retain the stored grant.
      throw error;
    }
  });
}

/** Caller holds the OAuth lock; decryption/provider failures must not prevent local signout. */
async function revokeAndClearOAuthCredentials(server: OAuthServer): Promise<void> {
  await clearOAuthServer(server.id);
  try {
    const credentials = readCredentials(server);
    if (credentials) await revokeAtProvider(credentials);
  } catch {
    // Corrupt/old credentials must never prevent local signout.
  }
}

/** Caller must resolve/authorize the server ID first. Safe to call repeatedly and on missing rows. */
export async function revokeMcpOAuthCredentials(serverId: string): Promise<void> {
  await withOAuthLock(serverId, async () => {
    const server = await readOAuthServer(serverId);
    if (!server || server.authKind !== "oauth") return;
    await revokeAndClearOAuthCredentials(server);
  });
}

/** Keep revocation and deletion inside one lock so a queued callback cannot install a new grant. */
export async function deleteMcpOAuthServer(serverId: string, userId: string): Promise<boolean> {
  return withOAuthLock(serverId, async () => {
    const server = await readOAuthServer(serverId);
    if (!server || server.userId !== userId || server.authKind !== "oauth") return false;
    await revokeAndClearOAuthCredentials(server);
    return deleteOwnedOAuthServerRow(serverId, userId);
  });
}

export function createMcpOAuthAuthorization(serverId: string) {
  return defineInteractiveAuthorization<{ enc: string }>({
    getToken: ({ principal }) => getMcpOAuthToken(serverId, principal),

    async evict({ principal }) {
      await withOAuthLock(serverId, async () => {
        const server = await ownedOAuthServer(serverId, principal);
        const credentials = readCredentials(server);
        if (credentials) await compareAndSetCredentials(server, sealOAuthValue(serverId, "credentials", {
          ...credentials, expiresAt: 0,
        }));
      });
    },

    async startAuthorization({ principal, callbackUrl }) {
      const server = await ownedOAuthServer(serverId, principal);
      try {
        const metadata = await discoverOAuth(server.url);
        const redirectUri = publicCallbackUrl(callbackUrl, loadConfig().appUrl);
        const client = await registerOAuthClient(metadata, redirectUri);
        // 48 random bytes produce exactly 64 unreserved PKCE characters.
        const verifier = randomBytes(48).toString("base64url");
        const state = randomBytes(32).toString("base64url");
        const flow: z.infer<typeof flowSchema> = {
          ...client, state, verifier, redirectUri,
          issuer: metadata.issuer, tokenEndpoint: metadata.token_endpoint,
          revocationEndpoint: metadata.revocation_endpoint ?? null,
          resource: metadata.resource, scope: metadata.scope,
          issuerParameterRequired: metadata.authorization_response_iss_parameter_supported === true,
          revision: server.revision, userId: server.userId,
        };
        return {
          challenge: {
            url: buildAuthorizationUrl(metadata.authorization_endpoint, flow),
            displayName: server.name,
          },
          resume: { enc: sealOAuthValue(serverId, "flow", flow) },
        };
      } catch (error) {
        throw authorizationFailure(server.slug, error instanceof OAuthProtocolError ? error.reason : "discovery_failed");
      }
    },

    async completeAuthorization({ principal, callbackUrl, resume, callback }) {
      // Ownership is checked before resume parsing or any external request.
      const server = await ownedOAuthServer(serverId, principal);
      let flow: z.infer<typeof flowSchema>;
      try {
        flow = flowSchema.parse(openOAuthValue(serverId, "flow", resume?.enc ?? ""));
      } catch {
        throw authorizationFailure(server.slug, "invalid_state");
      }
      if (flow.userId !== server.userId || flow.revision !== server.revision ||
          flow.redirectUri !== publicCallbackUrl(callbackUrl, loadConfig().appUrl)) {
        throw authorizationFailure(server.slug, "invalid_state");
      }
      const params = callback.params;
      if (params.error) {
        throw authorizationFailure(server.slug, params.error === "access_denied" ? "access_denied" : "provider_error");
      }
      if (!equalState(flow.state, params.state)) throw authorizationFailure(server.slug, "invalid_state");
      if (!validIssuerResponse(flow.issuer, flow.issuerParameterRequired, params.iss)) {
        throw authorizationFailure(server.slug, "issuer_mismatch");
      }
      if (!params.code) throw authorizationFailure(server.slug, "token_exchange_failed", true);
      return withOAuthLock(serverId, async () => {
        const current = await ownedOAuthServer(serverId, principal, server.slug);
        if (flow.revision !== current.revision) throw authorizationFailure(server.slug, "invalid_state");
        let exchanged: Awaited<ReturnType<typeof exchangeOAuthToken>>;
        try {
          exchanged = await exchangeOAuthToken(flow.tokenEndpoint, new URLSearchParams({
            grant_type: "authorization_code", code: params.code, redirect_uri: flow.redirectUri,
            code_verifier: flow.verifier, resource: flow.resource,
          }), flow);
        } catch {
          throw authorizationFailure(server.slug, "token_exchange_failed", true);
        }
        const credentials: OAuthCredentials = {
          access: exchanged.access, ...(exchanged.refresh ? { refresh: exchanged.refresh } : {}),
          expiresAt: exchanged.expiresAt, scope: exchanged.scope ?? flow.scope,
          tokenEndpoint: flow.tokenEndpoint, revocationEndpoint: flow.revocationEndpoint,
          issuer: flow.issuer, clientId: flow.clientId, clientSecret: flow.clientSecret,
          tokenEndpointAuthMethod: flow.tokenEndpointAuthMethod, resource: flow.resource,
        };
        if (!await compareAndSetCredentials(current, sealOAuthValue(serverId, "credentials", credentials))) {
          await revokeAtProvider(credentials);
          throw authorizationFailure(server.slug, "invalid_state");
        }
        return tokenResult(credentials);
      });
    },
  });
}
