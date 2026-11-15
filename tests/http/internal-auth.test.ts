import { randomUUID } from "node:crypto";
import { decodeJwt, SignJWT, type JWTPayload } from "jose";
import { afterAll, describe, expect, test } from "vitest";

import { signInternalToken, verifyInternalToken } from "../../lib/auth/internal-tokens";
import { loadConfig } from "../../lib/config";
import { appOutput, fetchApp } from "./support/app";
import { loginAs } from "./support/auth";
import { createSessionAs, eveClientAs } from "./support/chat";
import { createUser } from "./support/db";

const issuedTokens: string[] = [];

async function request(path: string, token: string | null, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (token !== null) {
    issuedTokens.push(token);
    headers.set("authorization", `Bearer ${token}`);
  }
  return fetchApp(path, { ...init, headers });
}

function post(body: unknown = {}): RequestInit {
  return { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

async function customToken(overrides: JWTPayload = {}, secret = loadConfig().internalApiSecret, algorithm = "HS256") {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    iss: "studio-app", aud: "studio-internal", iat: now, exp: now + 60,
    purpose: "eve_session_end", sid: "unbound-internal-auth-session", ...overrides,
  }).setProtectedHeader({ alg: algorithm }).sign(new TextEncoder().encode(secret));
}

describe("служебный JWT без приложения", () => {
  test("публичный API подписывает и проверяет назначение, sid и срок", async () => {
    const token = await signInternalToken("eve_session_end", { sid: "unit-session" });
    const payload = await verifyInternalToken(token);
    expect(payload).toMatchObject({ purpose: "eve_session_end", sid: "unit-session", iss: "studio-app", aud: "studio-internal" });
    expect(payload.exp - payload.iat).toBe(60);
  });

  test("отвергает неправильную подпись, аудиторию, срок и отсутствующие claims", async () => {
    const now = Math.floor(Date.now() / 1000);
    const tokens = await Promise.all([
      customToken({}, "wrong-secret-0123456789abcdef0123456789"),
      customToken({ aud: "wrong-audience" }),
      customToken({ iat: now - 120, exp: now - 60 }),
      customToken({ iat: now, exp: now + 61 }),
      customToken({ iat: undefined }),
      customToken({ exp: undefined }),
      customToken({ purpose: undefined }),
      customToken({ purpose: 42 }),
      customToken({ iat: now + 30, exp: now + 60 }),
      customToken({}, loadConfig().internalApiSecret, "HS384"),
    ]);
    for (const token of tokens) await expect(verifyInternalToken(token)).rejects.toThrow();
  });
});

describe("служебная аутентификация eve по HTTP", () => {
  afterAll(() => {
    const output = appOutput();
    expect(output.includes(loadConfig().internalApiSecret)).toBe(false);
    expect(issuedTokens.some((token) => output.includes(token))).toBe(false);
  });

  test("подписывает проверяемый токен на 60 секунд и допускает только cancel/reset его сессии", async () => {
    const sid = `internal-auth-${randomUUID()}`;
    const token = await signInternalToken("eve_session_end", { sid });
    const payload = await verifyInternalToken(token);
    expect(payload).toMatchObject({ purpose: "eve_session_end", sid, iss: "studio-app", aud: "studio-internal" });
    expect(payload.exp! - payload.iat!).toBe(60);
    expect(decodeJwt(token).sid).toBe(sid);

    const cancelled = await request(`/eve/v1/session/${sid}/cancel`, token, post());
    expect(cancelled.status).toBe(200);
    expect(await cancelled.json()).toMatchObject({ ok: true, status: "no_active_turn" });
    const reset = await request(`/eve/v1/session/${sid}/reset`, token, post({ reason: "deleted_by_user" }));
    expect(reset.status).toBe(200);
    expect(await reset.json()).toMatchObject({ ok: true, status: "no_active_session" });
  });

  test("без авторизации служебные маршруты закрыты", async () => {
    for (const action of ["cancel", "reset"]) {
      const response = await request(`/eve/v1/session/unbound-internal-auth-session/${action}`, null,
        post({ reason: "deleted_by_user" }));
      expect(response.status).toBe(401);
    }
  });

  test("служебный токен не читает потоки, не создаёт сессии и не меняет другой sid", async () => {
    const sid = "unbound-internal-auth-session";
    const token = await signInternalToken("eve_session_end", { sid });
    const routes: Array<[string, RequestInit]> = [
      [`/eve/v1/session/${sid}/stream?follow=false`, {}],
      ["/eve/v1/session", post()],
      [`/eve/v1/session/${sid}`, post({ message: "запрещено" })],
      [`/eve/v1/session/${sid}/clear`, post()],
      [`/eve/v1/session/${sid}/compact`, post()],
      [`/eve/v1/session/another-session/cancel`, post()],
      [`/eve/v1/session/another-session/reset`, post({ reason: "deleted_by_user" })],
      ["/eve/v1/info", {}],
    ];
    for (const [path, init] of routes) {
      const response = await request(path, token, init);
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code: "internal_token_forbidden" });
    }
  });

  test.each([
    "signature", "audience", "expired", "lifetime", "iat-missing", "exp-missing",
    "purpose-missing", "purpose-type", "future-iat", "algorithm",
  ])("неверный служебный JWT (%s) даёт 401 даже с рабочей cookie", async (kind) => {
    const user = await createUser({ isOperator: true });
    const cookie = await loginAs(user);
    const now = Math.floor(Date.now() / 1000);
    const overrides: Record<string, JWTPayload> = {
      audience: { aud: "another-service" },
      expired: { iat: now - 120, exp: now - 60 },
      lifetime: { iat: now, exp: now + 61 },
      "iat-missing": { iat: undefined },
      "exp-missing": { exp: undefined },
      "purpose-missing": { purpose: undefined },
      "purpose-type": { purpose: 42 },
      "future-iat": { iat: now + 30, exp: now + 60 },
    };
    const token = await customToken(overrides[kind],
      kind === "signature" ? "wrong-secret-0123456789abcdef0123456789" : loadConfig().internalApiSecret,
      kind === "algorithm" ? "HS384" : "HS256");
    const response = await request("/eve/v1/info", token, { headers: { cookie } });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: "invalid_internal_token" });
    await expect(verifyInternalToken(token)).rejects.toThrow();
  });

  test.each([{ purpose: "mcp_proxy", uid: "user", srv: "server" }, { sid: undefined }, { sid: 42 }])(
    "подписанные claims без нужных полномочий не дают доступа к eve: %j", async (claims) => {
      const token = await customToken(claims);
      const response = await request("/eve/v1/session/unbound-internal-auth-session/reset", token,
        post({ reason: "deleted_by_user" }));
      expect(response.status).toBe(403);
    },
  );

  test("cookie владельца работает без Bearer и с посторонним Bearer, eval остаётся отдельным", async () => {
    const user = await createUser();
    const cookie = await loginAs(user);
    const { id } = await createSessionAs(user);
    const client = await eveClientAs(user, id);
    const created = await client.sessions.create({ message: "проверка cookie" });
    const result = await created.response.result();
    expect(result.status).toBe("waiting");

    const foreignJwt = await customToken({ iss: "another-issuer" });
    for (const token of [null, "unknown-bearer", "not.a.jwt", foreignJwt]) {
      const response = await request(`/eve/v1/session/${result.sessionId}/stream?follow=false`, token,
        { headers: { cookie } });
      expect(response.status).toBe(200);
      await response.text();
    }
    const response = await request("/eve/v1/info", loadConfig().eveEvalAuthToken!);
    expect(response.status).toBe(200);
  }, 60_000);

  test("служебный токен отменяет и завершает существующую пользовательскую сессию без cookie", async () => {
    const user = await createUser();
    const { id } = await createSessionAs(user);
    const client = await eveClientAs(user, id);
    const created = await client.sessions.create({ message: "сессия для завершения" });
    const result = await created.response.result();
    expect(result.status).toBe("waiting");
    const sid = result.sessionId;
    const token = await signInternalToken("eve_session_end", { sid });
    const cancel = await request(`/eve/v1/session/${sid}/cancel`, token, post());
    expect([200, 202]).toContain(cancel.status);
    expect(await cancel.json()).toMatchObject({ ok: true });
    const reset = await request(`/eve/v1/session/${sid}/reset`, token, post({ reason: "deleted_by_user" }));
    expect(reset.status).toBe(200);
    expect(await reset.json()).toMatchObject({ ok: true, status: "reset" });
    const repeat = await request(`/eve/v1/session/${sid}/reset`, token, post({ reason: "deleted_by_user" }));
    expect(repeat.status).toBe(200);
    expect(await repeat.json()).toMatchObject({ ok: true, status: "no_active_session" });
  }, 60_000);
});
