import { describe, expect, it } from "vitest";

import { canonicalResource, parseBearerChallenge, authorizationMetadataUrls, pkceChallenge, tokenIsUsable, expiresAtFromSeconds, buildAuthorizationUrl, validIssuerResponse, publicCallbackUrl, authenticateClient, equalState } from "@/lib/mcp/oauth/protocol";

describe("MCP OAuth protocol", () => {
  it("canonicalizes a resource without discarding a significant endpoint path", () => {
    expect(canonicalResource("https://MCP.example:443/mcp/?tenant=1#x")).toBe("https://mcp.example/mcp/");
    expect(canonicalResource("https://MCP.example/?x=1")).toBe("https://mcp.example");
  });
  it("parses only Bearer challenge parameters, including quoted commas and escapes", () => {
    expect(parseBearerChallenge('Basic realm="legacy", Bearer realm="a,b", resource_metadata="https://mcp.example/meta?x=1", scope="read write", error_description="say \\"yes\\"", Digest realm="other"')).toEqual({
      realm: "a,b", resource_metadata: "https://mcp.example/meta?x=1", scope: "read write", error_description: 'say "yes"',
    });
  });
  it("handles legal whitespace around auth-param equals and an empty Bearer challenge", () => {
    expect(parseBearerChallenge('Bearer, scope  = "read write"')).toEqual({ scope: "read write" });
    expect(parseBearerChallenge('Bearer scope  = "read", resource_metadata = "https://mcp.example/meta"'))
      .toEqual({ scope: "read", resource_metadata: "https://mcp.example/meta" });
    expect(() => parseBearerChallenge('Bearer scope="read", scope="write"')).toThrow();
  });
  it("authenticates public, basic and post clients without mixing secret transport", () => {
    const publicForm = new URLSearchParams();
    expect(authenticateClient(publicForm, { clientId: "id", clientSecret: null, tokenEndpointAuthMethod: "none" })).not.toHaveProperty("Authorization");
    expect(publicForm.toString()).toBe("client_id=id");
    const basicForm = new URLSearchParams();
    const headers = authenticateClient(basicForm, { clientId: "a:b", clientSecret: "s p", tokenEndpointAuthMethod: "client_secret_basic" });
    expect(Buffer.from(headers.Authorization.slice(6), "base64").toString()).toBe("a%3Ab:s+p");
    expect(basicForm.has("client_secret")).toBe(false);
    const postForm = new URLSearchParams();
    expect(authenticateClient(postForm, { clientId: "id", clientSecret: "secret", tokenEndpointAuthMethod: "client_secret_post" })).not.toHaveProperty("Authorization");
    expect(postForm.toString()).toBe("client_id=id&client_secret=secret");
  });
  it("rejects missing and different states without length-sensitive Buffer comparisons", () => {
    expect(equalState("secret-state", "secret-state")).toBe(true);
    expect(equalState("secret-state", undefined)).toBe(false);
    expect(equalState("secret-state", "short")).toBe(false);
    expect(equalState("secret-state", "secret-statf")).toBe(false);
  });
  it("uses the MCP discovery priority for issuers with and without a path", () => {
    expect(authorizationMetadataUrls("https://auth.example/tenant/")).toEqual([
      "https://auth.example/.well-known/oauth-authorization-server/tenant",
      "https://auth.example/.well-known/openid-configuration/tenant",
      "https://auth.example/tenant/.well-known/openid-configuration",
    ]);
    expect(authorizationMetadataUrls("https://auth.example")).toHaveLength(2);
  });
  it("implements the S256 example in RFC 7636 Appendix B", () => {
    expect(pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });
  it("requires strictly more than the expiry margin", () => {
    expect(tokenIsUsable(null, 1_000)).toBe(true);
    expect(tokenIsUsable(61_001, 1_000)).toBe(true);
    expect(tokenIsUsable(61_000, 1_000)).toBe(false);
    expect(tokenIsUsable(60_999, 1_000)).toBe(false);
    expect(tokenIsUsable(2_001, 1_000, 1_000)).toBe(true);
    expect(expiresAtFromSeconds(3600, 1_000)).toBe(3_601_000);
    expect(expiresAtFromSeconds(undefined, 1_000)).toBe(null);
    expect(() => expiresAtFromSeconds(-1, 1_000)).toThrow();
  });
  it("validates the issuer response including mandatory and optional iss", () => {
    expect(validIssuerResponse("https://auth.example", true, undefined)).toBe(false);
    expect(validIssuerResponse("https://auth.example", false, undefined)).toBe(true);
    expect(validIssuerResponse("https://auth.example", false, "https://other.example")).toBe(false);
  });
  it("publishes the callback on APP_URL, preserving its attempt path and query", () => {
    expect(publicCallbackUrl("http://localhost:4274/eve/v1/connections/a/callback/id/token?x=1", "https://studio.example"))
      .toBe("https://studio.example/eve/v1/connections/a/callback/id/token?x=1");
  });
  it("sends the resource, callback and PKCE in the authorization request", () => {
    const url = new URL(buildAuthorizationUrl("https://auth.example/authorize?aud=x", {
      clientId: "client", redirectUri: "https://studio.example/cb", state: "state", verifier: "verifier", resource: "https://mcp.example/mcp", scope: "read write",
    }));
    expect(Object.fromEntries(url.searchParams)).toEqual({
      aud: "x", response_type: "code", client_id: "client", redirect_uri: "https://studio.example/cb", state: "state",
      code_challenge: pkceChallenge("verifier"), code_challenge_method: "S256", resource: "https://mcp.example/mcp", scope: "read write",
    });
  });
});
