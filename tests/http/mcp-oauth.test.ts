import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, test } from "vitest";
import type { MessageStreamEvent } from "eve/client";

import { loadConfig } from "@/lib/config";
import { getSqlClient } from "@/lib/db/client";
import { mcpServers } from "@/lib/db/schema";
import { createMcpOAuthAuthorization, getMcpOAuthToken } from "@/lib/mcp/oauth";
import { decryptSecret } from "@/lib/secrets";
import { appOutput, fetchApp } from "./support/app";
import { loginAs } from "./support/auth";
import { createSessionAs, sendAndWait, waitForStoredEvents } from "./support/chat";
import { createUser, db } from "./support/db";
import { fakeMcpServer } from "./support/fake-mcp";
import { fakeOAuthProvider } from "./support/fake-oauth";
import { OAUTH_ORIGIN, OAUTH_RESOURCE } from "./support/fake-oauth-provider";
import { completeOAuthInBrowser, oauthTurn } from "./support/mcp-oauth-flow";

beforeEach(async () => {
  await fakeMcpServer.reset();
  await fakeOAuthProvider.reset();
});

async function setupOAuth() {
  const user = await createUser();
  const cookie = await loginAs(user);
  const created = await fetchApp("/api/mcp-servers", {
    method: "POST", headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ name: "OAuth", url: OAUTH_RESOURCE, authKind: "oauth" }),
  });
  expect(created.status).toBe(201);
  // The public server view deliberately does not expose its internal connection slug.
  const server = {
    ...await created.json() as { id: string; connected: boolean },
    slug: "mcp-oauth",
  };
  const session = await createSessionAs(user);
  const start = `/tool eve__tool ${JSON.stringify({ name: server.slug })}`;
  const echo = `/tool eve__tool ${JSON.stringify({ name: `${server.slug}__echo`, input: { text: "привет" } })}`;
  return { user, cookie, server, session, start, echo };
}

async function encryptedCredentials(id: string) {
  const [row] = await db().select().from(mcpServers).where(eq(mcpServers.id, id));
  return row.credentialsEncrypted;
}

type OAuthContext = Awaited<ReturnType<typeof setupOAuth>>;

async function expectConnected(context: OAuthContext, connected: boolean) {
  const response = await fetchApp("/api/mcp-servers", { headers: { cookie: context.cookie } });
  expect(response.status).toBe(200);
  const { servers } = await response.json();
  expect(servers).toContainEqual(expect.objectContaining({ id: context.server.id, connected }));
}

async function expectNoSecrets(context: OAuthContext, events: readonly MessageStreamEvent[]) {
  const lastId = events.at(-1)?.meta.id;
  const stored = await waitForStoredEvents(context.user, context.session.id, (items) =>
    items.some(({ payload }) => payload.meta.id === lastId));
  const listed = await (await fetchApp("/api/mcp-servers", { headers: { cookie: context.cookie } })).text();
  const visible = JSON.stringify({ events, stored }) + listed + appOutput();
  const requests = await fakeOAuthProvider.requests();
  const values = (await fakeOAuthProvider.issued()).flatMap((item) => [item.access, item.refresh, item.clientSecret]);
  values.push(...requests.map((item) => item.body.code_verifier as string | undefined));
  for (const secret of values) {
    if (secret) expect(visible).not.toContain(secret);
  }
}

/** Public auth boundary for expiry tests: no HTTP fixture-only environment knobs. */
async function authorizeAtBoundary(context: OAuthContext) {
  const principal = { type: "user" as const, issuer: "studio", id: context.user.id };
  const connection = { url: `${loadConfig().appUrl}/api/mcp-proxy/${context.server.id}` };
  const callbackUrl = `http://localhost:4274/eve/v1/connections/${context.server.slug}/callback/test/test`;
  const auth = createMcpOAuthAuthorization(context.server.id);
  const pending = await auth.startAuthorization({ principal, connection, callbackUrl });
  expect(Object.keys(pending.resume!)).toEqual(["enc"]);
  const authorize = await fetch(pending.challenge.url!, { redirect: "manual" });
  expect(authorize.status).toBe(302);
  const returned = new URL(authorize.headers.get("location")!);
  const initial = await auth.completeAuthorization({
    principal, connection, callbackUrl, resume: pending.resume,
    callback: { method: "GET", params: Object.fromEntries(returned.searchParams) },
  });
  return { auth, principal, connection, initial, pending, callbackUrl };
}

describe("MCP OAuth", () => {
  test("входит через публичный callback, продолжает тот же поток и сохраняет вход для новых сессий", async () => {
    const context = await setupOAuth();
    const { user, cookie, server, session, start, echo } = context;
    expect(server.connected).toBe(false);
    expect(await encryptedCredentials(server.id)).toBeNull();
    const checkBefore = await fetchApp(`/api/mcp-servers/${server.id}/check`, { method: "POST", headers: { cookie } });
    expect(await checkBefore.json()).toEqual({
      ok: false, reason: "authorization_required",
      message: "Нужен вход через браузер: он выполнится в чате, когда агент впервые обратится к серверу.",
    });
    const events = await oauthTurn(user, session.id, start, async (event) => {
      expect(new URL(event.data.authorization!.url!).origin).toBe(OAUTH_ORIGIN);
      await completeOAuthInBrowser(event);
    });
    expect(events).toContainEqual(expect.objectContaining({
      type: "authorization.completed", data: expect.objectContaining({ outcome: "authorized" }),
    }));
    expect(events.at(-1)?.type).toBe("session.waiting");
    const requests = await fakeOAuthProvider.requests();
    const registration = requests.find((request) => request.path === "/register")!;
    const authorization = requests.find((request) => request.path === "/authorize")!;
    const exchange = requests.find((request) => request.path === "/token")!;
    expect(registration.body.redirect_uris).toEqual([authorization.params.redirect_uri]);
    expect(authorization.params.redirect_uri).toMatch(new RegExp(`^${loadConfig().appUrl}/eve/v1/connections/`));
    expect(authorization.params).toMatchObject({
      response_type: "code", code_challenge_method: "S256", resource: OAUTH_RESOURCE, scope: "mcp:read",
    });
    expect(authorization.params.state).not.toBe("");
    expect(exchange.body).toMatchObject({
      grant_type: "authorization_code", resource: OAUTH_RESOURCE, redirect_uri: authorization.params.redirect_uri,
    });
    expect(createHash("sha256").update(String(exchange.body.code_verifier)).digest("base64url"))
      .toBe(authorization.params.code_challenge);
    const [issued] = await fakeOAuthProvider.issued();
    const encrypted = await encryptedCredentials(server.id);
    expect(encrypted).toBeTruthy();
    expect(encrypted).not.toContain(issued.access);
    expect(encrypted).not.toContain(issued.refresh);
    const sameSession = await sendAndWait(user, session.id, echo);
    const another = await createSessionAs(user);
    const newSession = await sendAndWait(user, another.id, echo);
    expect(JSON.stringify(sameSession)).toContain("echo: привет");
    expect(JSON.stringify(newSession)).toContain("echo: привет");
    expect([...sameSession, ...newSession].some((event) => event.type === "authorization.required")).toBe(false);
    expect((await fakeOAuthProvider.requests()).filter((request) => request.path === "/register")).toHaveLength(1);
    expect((await fakeMcpServer.requests()).some((request) => request.headers.authorization === `Bearer ${issued.access}`)).toBe(true);
    const checkAfter = await fetchApp(`/api/mcp-servers/${server.id}/check`, { method: "POST", headers: { cookie } });
    expect(await checkAfter.json()).toMatchObject({ ok: true });
    const listed = await (await fetchApp("/api/mcp-servers", { headers: { cookie } })).json();
    expect(listed.servers).toContainEqual(expect.objectContaining({ id: server.id, connected: true }));
    const stored = await waitForStoredEvents(user, session.id, (items) =>
      items.some(({ payload }) => payload.meta.id === sameSession.at(-1)?.meta.id));
    const visible = JSON.stringify({ events, sameSession, newSession, stored, listed }) + appOutput();
    for (const secret of [issued.access, issued.refresh, exchange.body.code_verifier, issued.clientSecret]) {
      if (typeof secret === "string") expect(visible).not.toContain(secret);
    }
  }, 120_000);

  test("сброс входа отзывает refresh, изолирован по владельцу и даёт войти заново; удаление тоже отзывает", async () => {
    const context = await setupOAuth();
    const { user, cookie, server, session, start } = context;
    await oauthTurn(user, session.id, start);
    await expectConnected(context, true);
    const [first] = await fakeOAuthProvider.issued();
    const other = await createUser();
    const otherCookie = await loginAs(other);
    const beforeForeign = (await fakeOAuthProvider.requests()).length;
    for (const action of ["signout", "check"]) {
      expect((await fetchApp(`/api/mcp-servers/${server.id}/${action}`, {
        method: "POST", headers: { cookie: otherCookie },
      })).status).toBe(404);
    }
    expect((await fetchApp(`/api/mcp-servers/${server.id}`, {
      method: "DELETE", headers: { cookie: otherCookie },
    })).status).toBe(404);
    expect(await (await fetchApp("/api/mcp-servers", { headers: { cookie: otherCookie } })).json()).toEqual({ servers: [] });
    const otherSession = await createSessionAs(other);
    const attempts = await sendAndWait(other, otherSession.id, context.echo);
    expect(JSON.stringify(attempts)).not.toContain("echo: привет");
    expect(await fakeOAuthProvider.requests()).toHaveLength(beforeForeign);
    expect((await fetchApp(`/api/mcp-servers/${server.id}/signout`, {
      method: "POST", headers: { cookie, origin: "https://foreign.example" },
    })).status).toBe(403);
    expect((await fetchApp(`/api/mcp-servers/${server.id}/signout`, {
      method: "POST", headers: { cookie },
    })).status).toBe(204);
    expect(await encryptedCredentials(server.id)).toBeNull();
    await expectConnected(context, false);
    const revoked = (await fakeOAuthProvider.requests()).filter((item) => item.path === "/revoke");
    expect(revoked).toHaveLength(1);
    expect(revoked[0].body).toMatchObject({ token: first.refresh, token_type_hint: "refresh_token" });
    const check = await fetchApp(`/api/mcp-servers/${server.id}/check`, { method: "POST", headers: { cookie } });
    expect(await check.json()).toMatchObject({ ok: false, reason: "authorization_required" });
    const again = await oauthTurn(user, session.id, start);
    expect(again.some((event) => event.type === "authorization.required")).toBe(true);
    await expectConnected(context, true);
    const registrations = (await fakeOAuthProvider.requests()).filter((item) => item.path === "/register");
    expect(registrations).toHaveLength(2);
    expect(registrations[0].body.redirect_uris).not.toEqual(registrations[1].body.redirect_uris);
    const latest = (await fakeOAuthProvider.issued()).at(-1)!;
    expect((await fetchApp(`/api/mcp-servers/${server.id}`, { method: "DELETE", headers: { cookie } })).status).toBe(204);
    expect((await fakeOAuthProvider.requests()).filter((item) => item.path === "/revoke").at(-1)?.body)
      .toMatchObject({ token: latest.refresh, token_type_hint: "refresh_token" });
    expect(await db().select().from(mcpServers).where(eq(mcpServers.id, server.id))).toHaveLength(0);
    expect((await fetchApp(`/api/mcp-servers/${server.id}/signout`, { method: "POST", headers: { cookie } })).status).toBe(404);
    const bearer = await fetchApp("/api/mcp-servers", {
      method: "POST", headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "Bearer", url: "http://127.0.0.1:59210/bearer", authKind: "bearer", token: "secret-token" }),
    });
    expect(bearer.status).toBe(201);
    const { id } = await bearer.json();
    expect((await fetchApp(`/api/mcp-servers/${id}/signout`, { method: "POST", headers: { cookie } })).status).toBe(400);
  }, 120_000);

  test.each([
    ["deny", "access_denied"],
    ["tamperState", "invalid_state"],
    ["wrongIssuerParam", "issuer_mismatch"],
  ] as const)("отказ callback %s не сохраняет токены и не запрещает следующую попытку", async (mode, reason) => {
    const context = await setupOAuth();
    await fakeOAuthProvider.setModes({ [mode]: true });
    const events = await oauthTurn(context.user, context.session.id, context.start);
    expect(events).toContainEqual(expect.objectContaining({
      type: "authorization.completed", data: expect.objectContaining({ outcome: "failed", reason, retryable: false }),
    }));
    expect(await encryptedCredentials(context.server.id)).toBeNull();
    await expectConnected(context, false);
    expect((await fakeOAuthProvider.requests()).filter((item) => item.path === "/token")).toHaveLength(0);
    await expectNoSecrets(context, events);
    await fakeOAuthProvider.setModes({ [mode]: false });
    const retry = await oauthTurn(context.user, context.session.id, context.start);
    expect(retry).toContainEqual(expect.objectContaining({
      type: "authorization.completed", data: expect.objectContaining({ outcome: "authorized" }),
    }));
  }, 120_000);

  test.each([
    ["noPkce", "pkce_unsupported"],
    ["noRegistration", "registration_unsupported"],
    ["foreignResource", "resource_mismatch"],
    ["badMetadataAddress", "discovery_failed"],
  ] as const)("отказ discovery %s заканчивает вызов без карточки входа", async (mode, reason) => {
    const context = await setupOAuth();
    await fakeOAuthProvider.setModes({ [mode]: true });
    const events = await oauthTurn(context.user, context.session.id, context.start);
    expect(events.some((event) => event.type === "authorization.required")).toBe(false);
    expect(events.some((event) => event.type === "authorization.completed")).toBe(false);
    const results = events.filter((event) => event.type === "action.result");
    expect(JSON.stringify(results)).toContain(`${reason}:`);
    expect(await encryptedCredentials(context.server.id)).toBeNull();
    const providerRequests = await fakeOAuthProvider.requests();
    expect(providerRequests.filter((item) => ["/register", "/authorize", "/token"].includes(item.path))).toHaveLength(0);
    if (mode === "foreignResource") expect(providerRequests).toHaveLength(0);
    await expectNoSecrets(context, events);
  }, 90_000);

  test("новое сообщение отменяет ожидающий вход и не даёт позднему callback сохранить токены", async () => {
    const context = await setupOAuth();
    let authorizeUrl = "";
    const events = await oauthTurn(context.user, context.session.id, context.start, async (event) => {
      authorizeUrl = event.data.authorization!.url!;
      await sendAndWait(context.user, context.session.id, "Не входи, ответь без MCP");
    });
    expect(events).toContainEqual(expect.objectContaining({
      type: "authorization.completed", data: expect.objectContaining({ outcome: "declined" }),
    }));
    expect(await encryptedCredentials(context.server.id)).toBeNull();
    const authorize = await fetch(authorizeUrl, { redirect: "manual" });
    expect(authorize.status).toBe(302);
    const late = await fetch(authorize.headers.get("location")!, { redirect: "manual" });
    // Eve acknowledges delivery to the live session inbox, even after the
    // attempt was declined. HTTP acknowledgement is not authorization success.
    expect(late.status).toBe(200);
    await sendAndWait(context.user, context.session.id, "Продолжим без MCP");
    expect(await encryptedCredentials(context.server.id)).toBeNull();
    expect((await fakeOAuthProvider.requests()).filter((item) => item.path === "/token")).toHaveLength(0);
  }, 90_000);

  test("ошибка обмена кода не раскрывает verifier или клиентский секрет", async () => {
    await fakeOAuthProvider.setModes({ clientAuthMethod: "client_secret_basic", tokenFailure: "server_error" });
    const context = await setupOAuth();
    const events = await oauthTurn(context.user, context.session.id, context.start);
    expect(events).toContainEqual(expect.objectContaining({
      type: "authorization.completed", data: expect.objectContaining({ outcome: "failed", reason: "token_exchange_failed" }),
    }));
    expect(await encryptedCredentials(context.server.id)).toBeNull();
    const exchange = (await fakeOAuthProvider.requests()).find((item) => item.path === "/token")!;
    expect(exchange.authorization).toMatch(/^Basic /);
    const decoded = Buffer.from(exchange.authorization!.slice(6), "base64").toString();
    const secret = decodeURIComponent(decoded.slice(decoded.indexOf(":") + 1));
    expect(secret).toMatch(/^client-secret-/);
    const visible = JSON.stringify(events) + appOutput();
    expect(visible).not.toContain(secret);
    expect(visible).not.toContain(exchange.authorization!);
    await expectNoSecrets(context, events);
  }, 90_000);

  test("401 действующего access обновляет вход и повторяет MCP-запрос без нового браузера", async () => {
    const context = await setupOAuth();
    await oauthTurn(context.user, context.session.id, context.start);
    await fakeOAuthProvider.setModes({ rejectNextAccess: true });
    const events = await oauthTurn(context.user, context.session.id, context.echo);
    expect(JSON.stringify(events)).toContain("echo: привет");
    expect(events.some((event) => event.type === "authorization.required")).toBe(false);
    const refreshes = (await fakeOAuthProvider.requests()).filter((item) => item.body.grant_type === "refresh_token");
    expect(refreshes).toHaveLength(1);
    const issued = await fakeOAuthProvider.issued();
    expect(issued).toHaveLength(2);
    expect((await fakeMcpServer.requests()).some((item) => item.headers.authorization === `Bearer ${issued[1].access}`)).toBe(true);
    await expectNoSecrets(context, events);
  }, 90_000);

  test("отозванный grant очищается после invalid_grant и тот же поток запрашивает новый вход", async () => {
    const context = await setupOAuth();
    await oauthTurn(context.user, context.session.id, context.start);
    await fakeOAuthProvider.revokeAll();
    let requiredAgain = false;
    const events = await oauthTurn(context.user, context.session.id, context.echo, async (event) => {
      requiredAgain = true;
      expect(await encryptedCredentials(context.server.id)).toBeNull();
      await expectConnected(context, false);
      await completeOAuthInBrowser(event);
    });
    expect(requiredAgain).toBe(true);
    expect(events).toContainEqual(expect.objectContaining({
      type: "authorization.completed", data: expect.objectContaining({ outcome: "authorized" }),
    }));
    expect(JSON.stringify(events)).toContain("echo: привет");
    await expectNoSecrets(context, events);
  }, 90_000);

  test("check сообщает unauthorized при отказе сохранённого токена без запуска интерактивного входа", async () => {
    const context = await setupOAuth();
    await oauthTurn(context.user, context.session.id, context.start);
    await fakeOAuthProvider.revokeAll();
    const check = await fetchApp(`/api/mcp-servers/${context.server.id}/check`, {
      method: "POST", headers: { cookie: context.cookie },
    });
    expect(await check.json()).toMatchObject({ ok: false, reason: "unauthorized" });
    expect(await encryptedCredentials(context.server.id)).toBeTruthy();
    expect((await fakeOAuthProvider.requests()).filter((item) => item.path === "/register")).toHaveLength(1);
  }, 90_000);

  test("две конкурирующие функции обновления вращают истёкший refresh только один раз", async () => {
    const context = await setupOAuth();
    await fakeOAuthProvider.expiresIn(2);
    const boundary = await authorizeAtBoundary(context);
    const [first] = await fakeOAuthProvider.issued();
    expect((await getMcpOAuthToken(context.server.id, boundary.principal, { expiryMarginMs: 1000 })).token).toBe(first.access);
    expect((await fakeOAuthProvider.requests()).filter((item) => item.body.grant_type === "refresh_token")).toHaveLength(0);
    await new Promise((resolve) => setTimeout(resolve, 2100));
    await fakeOAuthProvider.expiresIn(3600);
    const [left, right] = await Promise.all([
      getMcpOAuthToken(context.server.id, boundary.principal, { expiryMarginMs: 1000 }),
      getMcpOAuthToken(context.server.id, boundary.principal, { expiryMarginMs: 1000 }),
    ]);
    expect(left.token).toBe(right.token);
    expect(left.token).not.toBe(first.access);
    const refreshes = (await fakeOAuthProvider.requests()).filter((item) => item.body.grant_type === "refresh_token");
    expect(refreshes).toHaveLength(1);
    expect(refreshes[0].body).toMatchObject({ refresh_token: first.refresh, resource: OAUTH_RESOURCE });
    const [latest] = (await fakeOAuthProvider.issued()).slice(-1);
    expect(left.token).toBe(latest.access);
    const replay = await fetch(`${OAUTH_ORIGIN}/token`, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: first.refresh, resource: OAUTH_RESOURCE, client_id: String(refreshes[0].body.client_id) }),
    });
    expect(replay.status).toBe(400);
    expect(await replay.json()).toEqual({ error: "invalid_grant" });
    const saved = await encryptedCredentials(context.server.id);
    expect(saved).not.toContain(latest.access);
    expect(saved).not.toContain(latest.refresh);
    const resume = JSON.stringify(boundary.pending.resume);
    expect(Object.keys(boundary.pending.resume!)).toEqual(["enc"]);
    const verifier = (await fakeOAuthProvider.requests()).find((item) => item.body.code_verifier)?.body.code_verifier as string;
    expect(resume).not.toContain(verifier);
    expect(resume).not.toContain(latest.access);
    expect(resume).not.toContain(latest.refresh);
    const decrypted = JSON.parse(decryptSecret(saved!, loadConfig().secretsEncryptionKey, `mcp-server:${context.server.id}`));
    expect(decrypted).toMatchObject({ access: latest.access, refresh: latest.refresh, resource: OAUTH_RESOURCE });
    const secondSession = await createSessionAs(context.user);
    const calls = await Promise.all([
      sendAndWait(context.user, context.session.id, context.echo),
      sendAndWait(context.user, secondSession.id, context.echo),
    ]);
    for (const events of calls) {
      expect(JSON.stringify(events)).toContain("echo: привет");
      expect(events.some((event) => event.type === "authorization.required")).toBe(false);
    }
  }, 90_000);

  test("два одновременных хода разных сессий eve обновляют общий grant ровно один раз", async () => {
    const context = await setupOAuth();
    await fakeOAuthProvider.expiresIn(3600);
    const boundary = await authorizeAtBoundary(context);
    const [first] = await fakeOAuthProvider.issued();
    const secondSession = await createSessionAs(context.user);
    await boundary.auth.evict!({ principal: boundary.principal, connection: boundary.connection });
    const before = (await fakeMcpServer.requests()).length;
    const echo = (text: string) => `/tool eve__tool ${JSON.stringify({
      name: `${context.server.slug}__echo`, input: { text },
    })}`;
    const [left, right] = await Promise.all([
      sendAndWait(context.user, context.session.id, echo("левая сессия")),
      sendAndWait(context.user, secondSession.id, echo("правая сессия")),
    ]);
    expect(JSON.stringify(left)).toContain("echo: левая сессия");
    expect(JSON.stringify(right)).toContain("echo: правая сессия");
    expect([...left, ...right].some((event) => event.type === "authorization.required")).toBe(false);
    const refreshes = (await fakeOAuthProvider.requests()).filter((item) => item.body.grant_type === "refresh_token");
    expect(refreshes).toHaveLength(1);
    expect(refreshes[0].body.refresh_token).toBe(first.refresh);
    const issued = await fakeOAuthProvider.issued();
    expect(issued).toHaveLength(2);
    expect(issued[1].access).not.toBe(first.access);
    const authorized = (await fakeMcpServer.requests()).slice(before)
      .filter((item) => item.path.startsWith("/mcp-oauth") && item.headers.authorization);
    expect(authorized.length).toBeGreaterThan(0);
    expect(authorized.every((item) => item.headers.authorization === `Bearer ${issued[1].access}`)).toBe(true);
    await expectNoSecrets(context, left);
    const storedRight = await waitForStoredEvents(context.user, secondSession.id, (items) =>
      items.some(({ payload }) => payload.meta.id === right.at(-1)?.meta.id));
    const visible = JSON.stringify({ left, right, storedRight }) + appOutput();
    for (const grant of issued) {
      expect(visible).not.toContain(grant.access);
      expect(visible).not.toContain(grant.refresh);
    }
  }, 90_000);

  test.each(["server_error", "invalid_grant"] as const)("evict сохраняет refresh, а %s при обновлении обрабатывается без утечки", async (failure) => {
    const context = await setupOAuth();
    const boundary = await authorizeAtBoundary(context);
    const [first] = await fakeOAuthProvider.issued();
    await boundary.auth.evict!({ principal: boundary.principal, connection: boundary.connection });
    await fakeOAuthProvider.setModes({ tokenFailure: failure });
    const request = getMcpOAuthToken(context.server.id, boundary.principal, { expiryMarginMs: 1000 });
    if (failure === "invalid_grant") {
      await expect(request).rejects.toMatchObject({ name: "ConnectionAuthorizationRequiredError" });
      expect(await encryptedCredentials(context.server.id)).toBeNull();
    } else {
      await expect(request).rejects.toThrow();
      expect(await encryptedCredentials(context.server.id)).toBeTruthy();
      await fakeOAuthProvider.setModes({ tokenFailure: null });
      const recovered = await getMcpOAuthToken(context.server.id, boundary.principal, { expiryMarginMs: 1000 });
      expect(recovered.token).not.toBe(first.access);
    }
    const refreshes = (await fakeOAuthProvider.requests()).filter((item) => item.body.grant_type === "refresh_token");
    expect(refreshes[0].body.refresh_token).toBe(first.refresh);
    expect(appOutput()).not.toContain(first.access);
    expect(appOutput()).not.toContain(first.refresh);
  }, 30_000);

  test.each(["client_secret_basic", "client_secret_post"] as const)("хранит клиентский секрет шифрованно и использует %s при обновлении и отзыве", async (method) => {
    const context = await setupOAuth();
    await fakeOAuthProvider.setModes({ clientAuthMethod: method });
    const boundary = await authorizeAtBoundary(context);
    const [first] = await fakeOAuthProvider.issued();
    expect(first.clientSecret).toMatch(/^client-secret-/);
    const encrypted = await encryptedCredentials(context.server.id);
    expect(encrypted).not.toContain(first.clientSecret!);
    expect(JSON.stringify(boundary.pending.resume)).not.toContain(first.clientSecret!);
    await boundary.auth.evict!({ principal: boundary.principal, connection: boundary.connection });
    const rotated = await getMcpOAuthToken(context.server.id, boundary.principal);
    expect(rotated.token).not.toBe(first.access);
    expect((await fetchApp(`/api/mcp-servers/${context.server.id}/signout`, {
      method: "POST", headers: { cookie: context.cookie },
    })).status).toBe(204);
    const requests = (await fakeOAuthProvider.requests()).filter((item) => item.path === "/token" || item.path === "/revoke");
    expect(requests).toHaveLength(3);
    for (const item of requests) {
      if (method === "client_secret_basic") {
        expect(item.authorization).toMatch(/^Basic /);
        expect(item.body.client_secret).toBeUndefined();
      } else {
        expect(item.authorization).toBeUndefined();
        expect(item.body.client_secret).toBe(first.clientSecret);
      }
    }
    expect(await encryptedCredentials(context.server.id)).toBeNull();
    expect(appOutput()).not.toContain(first.clientSecret!);
  }, 30_000);

  test("сбой отзыва не мешает локальному выходу и очистке токенов", async () => {
    const context = await setupOAuth();
    await authorizeAtBoundary(context);
    await fakeOAuthProvider.setModes({ revokeFailure: true });
    expect((await fetchApp(`/api/mcp-servers/${context.server.id}/signout`, {
      method: "POST", headers: { cookie: context.cookie },
    })).status).toBe(204);
    expect(await encryptedCredentials(context.server.id)).toBeNull();
    await expectConnected(context, false);
    expect((await fakeOAuthProvider.requests()).filter((item) => item.path === "/revoke")).toHaveLength(1);
  }, 30_000);

  test("сброс входа во время ожидания не позволяет позднему callback восстановить grant", async () => {
    const context = await setupOAuth();
    const events = await oauthTurn(context.user, context.session.id, context.start, async (event) => {
      expect((await fetchApp(`/api/mcp-servers/${context.server.id}/signout`, {
        method: "POST", headers: { cookie: context.cookie },
      })).status).toBe(204);
      await completeOAuthInBrowser(event);
    });
    expect(events).toContainEqual(expect.objectContaining({
      type: "authorization.completed", data: expect.objectContaining({ outcome: "failed", reason: "invalid_state" }),
    }));
    expect(await encryptedCredentials(context.server.id)).toBeNull();
    await expectConnected(context, false);
    expect((await fakeOAuthProvider.requests()).filter((item) => item.path === "/token")).toHaveLength(0);
  }, 90_000);

  test("удаление удерживает OAuth-блокировку до удаления строки и не обменивает код ожидающего callback", async () => {
    const context = await setupOAuth();
    const boundary = await authorizeAtBoundary(context);
    await fakeOAuthProvider.holdRevocation();
    const deleting = fetchApp(`/api/mcp-servers/${context.server.id}`, {
      method: "DELETE", headers: { cookie: context.cookie },
    });
    let completion: Promise<{ ok: true } | { ok: false; error: unknown }> | undefined;
    try {
      // Revoke has already cleared credentials, but its HTTP response is still held.
      await fakeOAuthProvider.waitForRevocation();
      expect(await encryptedCredentials(context.server.id)).toBeNull();
      const pending = await boundary.auth.startAuthorization({
        principal: boundary.principal, connection: boundary.connection, callbackUrl: boundary.callbackUrl,
      });
      const authorization = await fetch(pending.challenge.url!, { redirect: "manual" });
      expect(authorization.status).toBe(302);
      const callback = new URL(authorization.headers.get("location")!);
      const beforeExchange = (await fakeOAuthProvider.requests()).filter((item) => item.path === "/token").length;
      completion = boundary.auth.completeAuthorization({
        principal: boundary.principal, connection: boundary.connection, callbackUrl: boundary.callbackUrl,
        resume: pending.resume,
        callback: { method: "GET", params: Object.fromEntries(callback.searchParams) },
      }).then(() => ({ ok: true as const }), (error: unknown) => ({ ok: false as const, error }));
      // Observe the queued callback rather than relying on a scheduling delay.
      await expect.poll(async () => {
        const waiting = await getSqlClient()`select 1 from pg_locks
          where locktype = 'advisory' and classid = 3 and not granted
          and objid::bigint = (hashtext(${context.server.id})::bigint & 4294967295)`;
        return waiting.length;
      }, { timeout: 3000, interval: 25 }).toBeGreaterThan(0);
      await fakeOAuthProvider.releaseRevocation();
      expect((await deleting).status).toBe(204);
      const completed = await completion;
      expect(completed.ok).toBe(false);
      if (!completed.ok) expect(completed.error).toMatchObject({ reason: "wrong_user", retryable: false });
      expect(await db().select().from(mcpServers).where(eq(mcpServers.id, context.server.id))).toHaveLength(0);
      const providerRequests = await fakeOAuthProvider.requests();
      expect(providerRequests.filter((item) => item.path === "/token")).toHaveLength(beforeExchange);
      expect(providerRequests.filter((item) => item.path === "/revoke")).toHaveLength(1);
      expect(await fakeOAuthProvider.issued()).toHaveLength(1);
    } finally {
      await fakeOAuthProvider.releaseRevocation();
      await Promise.allSettled([deleting, ...(completion ? [completion] : [])]);
    }
  }, 30_000);

  test("getToken и completeAuthorization отвергают чужого владельца, authenticator и app principal", async () => {
    const context = await setupOAuth();
    const boundary = await authorizeAtBoundary(context);
    const other = await createUser();
    const before = (await fakeOAuthProvider.requests()).length;
    const saved = await encryptedCredentials(context.server.id);
    const principals = [
      { type: "user" as const, issuer: "studio", id: other.id },
      { type: "user" as const, issuer: "foreign", id: context.user.id },
      { type: "app" as const },
    ];
    for (const principal of principals) {
      await expect(getMcpOAuthToken(context.server.id, principal))
        .rejects.toMatchObject({ reason: "wrong_user", retryable: false });
      await expect(boundary.auth.completeAuthorization({
        principal, connection: boundary.connection, callbackUrl: boundary.callbackUrl,
        resume: boundary.pending.resume,
        callback: { method: "GET", params: { code: "must-not-be-exchanged", state: "wrong" } },
      })).rejects.toMatchObject({ reason: "wrong_user", retryable: false });
    }
    // Invalid IDs cannot be queried as UUIDs: auth must reject these principals first.
    for (const principal of principals.slice(1)) {
      await expect(getMcpOAuthToken("not-a-uuid", principal))
        .rejects.toMatchObject({ reason: "wrong_user", retryable: false });
      await expect(createMcpOAuthAuthorization("not-a-uuid").completeAuthorization({
        principal, connection: boundary.connection, callbackUrl: boundary.callbackUrl,
        resume: { enc: "must-not-be-decrypted" },
        callback: { method: "GET", params: {} },
      })).rejects.toMatchObject({ reason: "wrong_user", retryable: false });
    }
    expect(await encryptedCredentials(context.server.id)).toBe(saved);
    expect(await fakeOAuthProvider.requests()).toHaveLength(before);
  }, 30_000);
});
