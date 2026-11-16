import { z } from "zod";

import { OAuthProtocolError } from "./errors";
import { jsonObject, oauthFetch } from "./http";
import { authenticateClient, expiresAtFromSeconds } from "./protocol";

export const credentialsSchema = z.object({
  access: z.string().min(1).regex(/^[A-Za-z0-9\-._~+/]+=*$/),
  refresh: z.string().min(1).optional(),
  expiresAt: z.number().finite().nullable(),
  scope: z.string(),
  tokenEndpoint: z.string().min(1),
  revocationEndpoint: z.string().nullable(),
  issuer: z.string().min(1),
  clientId: z.string().min(1),
  clientSecret: z.string().nullable(),
  tokenEndpointAuthMethod: z.enum(["none", "client_secret_basic", "client_secret_post"]),
  resource: z.string().min(1),
});

export type OAuthCredentials = z.infer<typeof credentialsSchema>;
export type OAuthClient = Pick<OAuthCredentials, "clientId" | "clientSecret" | "tokenEndpointAuthMethod">;

export class InvalidRefreshGrant extends Error {}

export async function exchangeOAuthToken(endpoint: string, form: URLSearchParams, client: OAuthClient, refresh = false) {
  const headers = authenticateClient(form, client);
  let data: Record<string, unknown>;
  try {
    const response = await oauthFetch(endpoint, { method: "POST", headers, body: form.toString() });
    // A server failure must never wipe an otherwise recoverable refresh grant.
    if (response.status >= 500) throw new Error("Сервер авторизации временно недоступен");
    data = jsonObject(response);
    if (refresh && response.status >= 400 && response.status < 500 && data.error === "invalid_grant") {
      throw new InvalidRefreshGrant();
    }
    if (response.status !== 200) throw new OAuthProtocolError("token_exchange_failed");
    if (typeof data.token_type !== "string" || data.token_type.toLowerCase() !== "bearer" ||
        typeof data.access_token !== "string" || !/^[A-Za-z0-9\-._~+/]+=*$/.test(data.access_token)) {
      throw new OAuthProtocolError("token_exchange_failed");
    }
    const expiresAt = expiresAtFromSeconds(data.expires_in);
    if (data.refresh_token !== undefined && (typeof data.refresh_token !== "string" || !data.refresh_token)) {
      throw new OAuthProtocolError("token_exchange_failed");
    }
    if (data.scope !== undefined && typeof data.scope !== "string") throw new OAuthProtocolError("token_exchange_failed");
    return {
      access: data.access_token,
      refresh: data.refresh_token as string | undefined,
      expiresAt,
      scope: data.scope as string | undefined,
    };
  } catch (error) {
    if (error instanceof InvalidRefreshGrant) throw error;
    // Never expose provider error bodies or request parameters through eve.
    throw new OAuthProtocolError("token_exchange_failed");
  }
}

export async function revokeAtProvider(credentials: OAuthCredentials): Promise<void> {
  if (!credentials.revocationEndpoint) return;
  try {
    const form = new URLSearchParams({
      token: credentials.refresh ?? credentials.access,
      token_type_hint: credentials.refresh ? "refresh_token" : "access_token",
    });
    await oauthFetch(credentials.revocationEndpoint, {
      method: "POST", headers: authenticateClient(form, credentials), body: form.toString(),
    });
  } catch {
    // Local signout is authoritative. Remote revocation is best effort, bounded to ten seconds.
  }
}
