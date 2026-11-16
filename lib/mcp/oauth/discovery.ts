import { z } from "zod";

import { OAuthProtocolError } from "./errors";
import { jsonObject, oauthFetch, validateOAuthEndpoint } from "./http";
import { authorizationMetadataUrls, canonicalResource, parseBearerChallenge, type TokenEndpointAuthMethod } from "./protocol";

const resourceSchema = z.object({
  resource: z.string().min(1),
  authorization_servers: z.array(z.string().min(1)).min(1).max(20),
  scopes_supported: z.array(z.string()).optional(),
});

const authorizationSchema = z.object({
  issuer: z.string(),
  authorization_endpoint: z.string().min(1),
  token_endpoint: z.string().min(1),
  registration_endpoint: z.string().min(1).optional(),
  revocation_endpoint: z.string().min(1).optional(),
  code_challenge_methods_supported: z.array(z.string()).optional(),
  token_endpoint_auth_methods_supported: z.array(z.string()).optional(),
  authorization_response_iss_parameter_supported: z.boolean().optional(),
});

async function getMetadata(url: string) {
  const response = await oauthFetch(url, { headers: { Accept: "application/json" } });
  if (response.status !== 200) throw new Error("Метаданные недоступны");
  return jsonObject(response);
}

export async function discoverOAuth(serverUrl: string) {
  try {
    const canonical = canonicalResource(serverUrl);
    const origin = new URL(serverUrl).origin;
    const path = new URL(serverUrl).pathname;
    const probe = await oauthFetch(serverUrl, {
      method: "POST",
      headers: { Accept: "application/json, text/event-stream", "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "42 AI Studio", version: "1" } },
      }),
    }, true);
    const challenge = probe.status === 401 ? parseBearerChallenge(probe.headers.get("www-authenticate")) : {};
    const candidates = challenge.resource_metadata
      ? [{ url: challenge.resource_metadata, expected: canonical }]
      : [
          ...(path !== "/" ? [{ url: `${origin}/.well-known/oauth-protected-resource${path}`, expected: canonical }] : []),
          { url: `${origin}/.well-known/oauth-protected-resource`, expected: origin },
        ];
    let resource: z.infer<typeof resourceSchema> | undefined;
    for (const candidate of candidates) {
      let document: Record<string, unknown>;
      try { document = await getMetadata(candidate.url); }
      catch { continue; }
      // Do not fall back to a broader resource after a resource-binding failure.
      if (document.resource !== candidate.expected) throw new OAuthProtocolError("resource_mismatch");
      resource = resourceSchema.parse(document);
      break;
    }
    if (!resource) throw new OAuthProtocolError("discovery_failed");
    const scope = challenge.scope ?? resource.scopes_supported?.join(" ") ?? "";
    for (const issuer of resource.authorization_servers) {
      let addresses: string[];
      try {
        await validateOAuthEndpoint(issuer);
        addresses = authorizationMetadataUrls(issuer);
      } catch { continue; }
      for (const url of addresses) {
        let document: z.infer<typeof authorizationSchema>;
        try {
          document = authorizationSchema.parse(await getMetadata(url));
          if (document.issuer !== issuer) continue;
          await Promise.all([
            validateOAuthEndpoint(document.authorization_endpoint),
            validateOAuthEndpoint(document.token_endpoint),
            ...(document.registration_endpoint ? [validateOAuthEndpoint(document.registration_endpoint)] : []),
            ...(document.revocation_endpoint ? [validateOAuthEndpoint(document.revocation_endpoint)] : []),
          ]);
        } catch { continue; }
        if (!document.code_challenge_methods_supported?.includes("S256")) throw new OAuthProtocolError("pkce_unsupported");
        if (!document.registration_endpoint) throw new OAuthProtocolError("registration_unsupported");
        const methods = document.token_endpoint_auth_methods_supported ?? ["client_secret_basic"];
        const authMethod: TokenEndpointAuthMethod | undefined = methods.includes("none") ? "none"
          : methods.includes("client_secret_basic") ? "client_secret_basic"
            : methods.includes("client_secret_post") ? "client_secret_post" : undefined;
        if (!authMethod) throw new OAuthProtocolError("registration_unsupported");
        return { ...document, registration_endpoint: document.registration_endpoint, resource: resource.resource, scope, authMethod };
      }
    }
    throw new OAuthProtocolError("discovery_failed");
  } catch (error) {
    if (error instanceof OAuthProtocolError) throw error;
    throw new OAuthProtocolError("discovery_failed");
  }
}

export async function registerOAuthClient(metadata: Awaited<ReturnType<typeof discoverOAuth>>, redirectUri: string) {
  const response = await oauthFetch(metadata.registration_endpoint, {
    method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_name: "42 AI Studio", redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"], response_types: ["code"],
      token_endpoint_auth_method: metadata.authMethod,
    }),
  });
  if (response.status !== 200 && response.status !== 201) throw new OAuthProtocolError("discovery_failed");
  const registration = z.object({
    client_id: z.string().min(1), client_secret: z.string().min(1).optional(),
    token_endpoint_auth_method: z.enum(["none", "client_secret_basic", "client_secret_post"]).optional(),
    redirect_uris: z.array(z.string()).optional(),
  }).parse(jsonObject(response));
  const authMethod = registration.token_endpoint_auth_method ?? metadata.authMethod;
  if (authMethod !== "none" && !registration.client_secret) throw new OAuthProtocolError("discovery_failed");
  if (registration.redirect_uris && !registration.redirect_uris.includes(redirectUri)) throw new OAuthProtocolError("discovery_failed");
  return { clientId: registration.client_id, clientSecret: registration.client_secret ?? null, tokenEndpointAuthMethod: authMethod };
}
