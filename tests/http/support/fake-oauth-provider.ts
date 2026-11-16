import { createHash, randomUUID } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";

export const OAUTH_ORIGIN = "http://127.0.0.1:59211";
export const OAUTH_RESOURCE = "http://127.0.0.1:59210/mcp-oauth";

export interface OAuthModes {
  deny?: boolean;
  noPkce?: boolean;
  noRegistration?: boolean;
  wrongIssuerParam?: boolean;
  tamperState?: boolean;
  badMetadataAddress?: boolean;
  foreignResource?: boolean;
  rejectNextAccess?: boolean;
  expiresIn?: number;
  tokenFailure?: "invalid_grant" | "server_error" | null;
  revokeFailure?: boolean;
  clientAuthMethod?: "none" | "client_secret_basic" | "client_secret_post";
}

export interface OAuthRequest {
  method: string;
  path: string;
  params: Record<string, string>;
  body: Record<string, unknown>;
  authorization?: string;
}

interface Grant {
  clientId: string;
  resource: string;
  expiresAt: number;
}

/** One instance is shared by the two external test servers, never by application code. */
export function createFakeOAuthState() {
  let modes: OAuthModes = {};
  const requests: OAuthRequest[] = [];
  const clients = new Map<string, { redirectUri: string; secret?: string; method: string }>();
  const codes = new Map<string, { clientId: string; redirectUri: string; challenge: string; resource: string }>();
  const access = new Map<string, Grant>();
  const refresh = new Map<string, Grant>();
  const issued: Array<{ access: string; refresh: string; clientSecret?: string }> = [];
  let revokeGate: {
    entered: Promise<void>;
    markEntered: () => void;
    released: Promise<void>;
    release: () => void;
  } | undefined;

  function releaseRevocation() {
    revokeGate?.release();
    revokeGate = undefined;
  }

  return {
    get modes() { return modes; },
    requests,
    clients,
    codes,
    access,
    refresh,
    issued,
    holdRevocation() {
      if (revokeGate) throw new Error("Revocation is already held");
      let markEntered!: () => void;
      let release!: () => void;
      const entered = new Promise<void>((resolve) => { markEntered = resolve; });
      const released = new Promise<void>((resolve) => { release = resolve; });
      revokeGate = { entered, markEntered, released, release };
    },
    async waitForRevocation() {
      if (!revokeGate) throw new Error("Revocation must be held before waiting");
      await revokeGate.entered;
    },
    async pauseRevocation() {
      const gate = revokeGate;
      if (gate) {
        gate.markEntered();
        await gate.released;
      }
    },
    releaseRevocation,
    setModes(value: OAuthModes) { modes = { ...modes, ...value }; },
    reset() {
      releaseRevocation();
      modes = {};
      requests.length = 0;
      issued.length = 0;
      clients.clear();
      codes.clear();
      access.clear();
      refresh.clear();
    },
    revokeAll() { access.clear(); refresh.clear(); },
    accepts(header: string | undefined) {
      const grant = header?.startsWith("Bearer ") ? access.get(header.slice(7)) : undefined;
      if (!grant || grant.expiresAt <= Date.now()) return false;
      if (modes.rejectNextAccess) { modes.rejectNextAccess = false; return false; }
      return true;
    },
    issue(clientId: string, resource: string) {
      const accessToken = `access-${randomUUID()}`;
      const refreshToken = `refresh-${randomUUID()}`;
      const seconds = modes.expiresIn ?? 3600;
      const grant = { clientId, resource, expiresAt: Date.now() + seconds * 1000 };
      access.set(accessToken, grant);
      refresh.set(refreshToken, grant);
      issued.push({ access: accessToken, refresh: refreshToken, clientSecret: clients.get(clientId)?.secret });
      return { access_token: accessToken, refresh_token: refreshToken, token_type: "Bearer", expires_in: seconds, scope: "mcp:read" };
    },
  };
}

export type FakeOAuthState = ReturnType<typeof createFakeOAuthState>;

function json(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
}

export async function startFakeOAuthProvider(state: FakeOAuthState, port = 59211) {
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", OAUTH_ORIGIN);
      let raw = "";
      for await (const chunk of request) raw += chunk;
      const body: Record<string, unknown> = raw
        ? request.headers["content-type"]?.includes("application/json")
          ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw))
        : {};
      if (url.pathname === "/__control") {
        if (request.method === "POST") {
          if (body.reset) state.reset();
          if (body.revokeAll) state.revokeAll();
          if (body.modes) state.setModes(body.modes as OAuthModes);
          if (body.holdRevocation) state.holdRevocation();
          if (body.releaseRevocation) state.releaseRevocation();
          if (body.waitForRevocation) await state.waitForRevocation();
        }
        json(response, 200, { requests: state.requests, issued: state.issued, modes: state.modes });
        return;
      }
      state.requests.push({
        method: request.method ?? "GET", path: url.pathname,
        params: Object.fromEntries(url.searchParams), body,
        authorization: request.headers.authorization,
      });
      const mode = state.modes;
      if (url.pathname === "/.well-known/oauth-authorization-server") {
        const endpoint = mode.badMetadataAddress ? "http://127.0.0.1:1" : OAUTH_ORIGIN;
        json(response, 200, {
          issuer: OAUTH_ORIGIN,
          authorization_endpoint: `${endpoint}/authorize`, token_endpoint: `${endpoint}/token`,
          ...(!mode.noRegistration ? { registration_endpoint: `${endpoint}/register` } : {}),
          revocation_endpoint: `${endpoint}/revoke`,
          ...(!mode.noPkce ? { code_challenge_methods_supported: ["S256"] } : {}),
          token_endpoint_auth_methods_supported: [mode.clientAuthMethod ?? "none"],
          authorization_response_iss_parameter_supported: true,
          response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"],
        });
        return;
      }
      if (url.pathname === "/register" && request.method === "POST") {
        const redirects = body.redirect_uris;
        if (!Array.isArray(redirects) || typeof redirects[0] !== "string") {
          json(response, 400, { error: "invalid_redirect_uri" }); return;
        }
        const method = mode.clientAuthMethod ?? "none";
        if (body.token_endpoint_auth_method !== method) {
          json(response, 400, { error: "invalid_client_metadata" }); return;
        }
        const clientId = `client-${randomUUID()}`;
        const secret = method === "none" ? undefined : `client-secret-${randomUUID()}`;
        state.clients.set(clientId, { redirectUri: redirects[0], secret, method });
        json(response, 201, { client_id: clientId, ...(secret ? { client_secret: secret } : {}), token_endpoint_auth_method: method, redirect_uris: redirects });
        return;
      }
      if (url.pathname === "/authorize") {
        const params = url.searchParams;
        const clientId = params.get("client_id") ?? "";
        const client = state.clients.get(clientId);
        if (!client || client.redirectUri !== params.get("redirect_uri") ||
            params.get("response_type") !== "code" || params.get("code_challenge_method") !== "S256" ||
            !params.get("code_challenge") || !params.get("state") ||
            params.get("resource") !== OAUTH_RESOURCE || params.get("scope") !== "mcp:read") {
          json(response, 400, { error: "invalid_request" }); return;
        }
        const callback = new URL(client.redirectUri);
        callback.searchParams.set("state", mode.tamperState ? "tampered-state" : params.get("state")!);
        callback.searchParams.set("iss", mode.wrongIssuerParam ? "https://wrong.example" : OAUTH_ORIGIN);
        if (mode.deny) callback.searchParams.set("error", "access_denied");
        else {
          const code = `code-${randomUUID()}`;
          state.codes.set(code, { clientId, redirectUri: client.redirectUri, challenge: params.get("code_challenge")!, resource: OAUTH_RESOURCE });
          callback.searchParams.set("code", code);
        }
        response.writeHead(302, { location: callback.toString() }).end();
        return;
      }
      if (url.pathname === "/token" || url.pathname === "/revoke") {
        let clientId = String(body.client_id ?? "");
        let secret = body.client_secret;
        if (request.headers.authorization?.startsWith("Basic ")) {
          const decoded = Buffer.from(request.headers.authorization.slice(6), "base64").toString();
          const colon = decoded.indexOf(":");
          clientId = decodeURIComponent(decoded.slice(0, colon));
          secret = decodeURIComponent(decoded.slice(colon + 1));
        }
        const client = state.clients.get(clientId);
        if (!client || (client.secret && secret !== client.secret)) {
          json(response, 401, { error: "invalid_client" }); return;
        }
        if (url.pathname === "/revoke") {
          await state.pauseRevocation();
          if (mode.revokeFailure) {
            json(response, 503, { error: "server_error" }); return;
          }
          const grant = state.refresh.get(String(body.token)) ?? state.access.get(String(body.token));
          state.refresh.delete(String(body.token));
          state.access.delete(String(body.token));
          if (grant) {
            for (const [token, accessGrant] of state.access) {
              if (accessGrant === grant) state.access.delete(token);
            }
          }
          response.writeHead(200).end(); return;
        }
        if (mode.tokenFailure) {
          json(response, mode.tokenFailure === "server_error" ? 503 : 400, { error: mode.tokenFailure }); return;
        }
        if (body.grant_type === "authorization_code") {
          const code = state.codes.get(String(body.code));
          state.codes.delete(String(body.code));
          const challenge = createHash("sha256").update(String(body.code_verifier)).digest("base64url");
          if (!code || code.clientId !== clientId || code.redirectUri !== body.redirect_uri ||
              code.challenge !== challenge || code.resource !== body.resource) {
            json(response, 400, { error: "invalid_grant" }); return;
          }
          json(response, 200, state.issue(clientId, code.resource)); return;
        }
        if (body.grant_type === "refresh_token") {
          const grant = state.refresh.get(String(body.refresh_token));
          state.refresh.delete(String(body.refresh_token));
          if (!grant || grant.clientId !== clientId || grant.resource !== body.resource) {
            json(response, 400, { error: "invalid_grant" }); return;
          }
          json(response, 200, state.issue(clientId, grant.resource)); return;
        }
        json(response, 400, { error: "unsupported_grant_type" }); return;
      }
      response.writeHead(404).end();
    } catch {
      json(response, 400, { error: "invalid_request" });
    }
  });
  await new Promise<void>((resolve, reject) => server.once("error", reject).listen(port, "127.0.0.1", resolve));
  return { close: async () => {
    state.releaseRevocation();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  } };
}
