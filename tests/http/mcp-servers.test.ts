import { beforeEach, describe, expect, test } from "vitest";

import { signInternalToken } from "@/lib/auth/internal-tokens";
import { eq } from "drizzle-orm";
import { mcpServers } from "@/lib/db/schema";
import { decryptSecret } from "@/lib/secrets";
import { loadConfig } from "@/lib/config";
import { fetchApp } from "./support/app";
import { loginAs } from "./support/auth";
import { createSessionAs, sendAndWait } from "./support/chat";
import { createUser, db } from "./support/db";
import { fakeMcpServer } from "./support/fake-mcp";

const upstreamHost = loadConfig().ssrfTestAllowHosts[0];
const upstreamUrl = `http://${upstreamHost}`;
beforeEach(() => fakeMcpServer.reset());

describe("MCP-серверы пользователя", () => {
  test("сохраняет секрет отдельно и проверяет соединение", async () => {
    const user = await createUser();
    const cookie = await loginAs(user);
    const response = await fetchApp("/api/mcp-servers", {
      method: "POST", headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "Мой сервер", url: `${upstreamUrl}/bearer?key=private`, authKind: "bearer", token: "secret-token" }),
    });
    expect(response.status).toBe(201);
    const server = await response.json();
    expect(JSON.stringify(server)).not.toContain("secret-token");
    expect(JSON.stringify(server)).not.toContain("private");
    const [stored] = await db().select().from(mcpServers).where(eq(mcpServers.id, server.id));
    expect(stored.slug).toBe("mcp-moy-server");
    expect(stored.credentialsEncrypted).not.toContain("secret-token");
    expect(() => decryptSecret(stored.credentialsEncrypted!, loadConfig().secretsEncryptionKey, "mcp-server:other")).toThrow();
    const checked = await fetchApp(`/api/mcp-servers/${server.id}/check`, { method: "POST", headers: { cookie } });
    expect(await checked.json()).toEqual({ ok: true, toolCount: 1, tools: ["echo"] });
    expect((await fakeMcpServer.requests()).some((request) => request.headers.authorization === "Bearer secret-token")).toBe(true);
    expect((await fakeMcpServer.requests()).every((request) => !request.headers.cookie && !request.headers["x-studio-mcp-token"])).toBe(true);
    const token = await signInternalToken("mcp_proxy", { uid: user.id, srv: server.id });
    const proxied = await fetchApp(`/api/mcp-proxy/${server.id}`, {
      method: "POST",
      headers: { "x-studio-mcp-token": token, cookie: "secret-cookie", "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/list" }),
    });
    expect(proxied.status).toBe(200);
    expect((await proxied.json()).result.tools[0].name).toBe("echo");
    expect((await fakeMcpServer.requests()).at(-1)?.headers).toMatchObject({ authorization: "Bearer secret-token", "user-agent": "42-ai-studio-mcp/1" });
    const beforeOversized = (await fakeMcpServer.requests()).length;
    const oversized = await fetchApp(`/api/mcp-proxy/${server.id}`, {
      method: "POST", headers: { "x-studio-mcp-token": token }, body: "x".repeat(5 * 1024 * 1024),
    });
    expect(oversized.status).toBe(413);
    expect(await fakeMcpServer.requests()).toHaveLength(beforeOversized);
    const other = await createUser();
    const otherCookie = await loginAs(other);
    expect((await fetchApp(`/api/mcp-servers/${server.id}`, { method: "DELETE", headers: { cookie: otherCookie } })).status).toBe(404);
    expect(await (await fetchApp("/api/mcp-servers", { headers: { cookie: otherCookie } })).json()).toEqual({ servers: [] });
    const otherToken = await signInternalToken("mcp_proxy", { uid: other.id, srv: server.id });
    expect((await fetchApp(`/api/mcp-proxy/${server.id}`, { headers: { "x-studio-mcp-token": otherToken } })).status).toBe(403);
    const session = await createSessionAs(user);
    const beforeAgent = (await fakeMcpServer.requests()).length;
    const events = await sendAndWait(user, session.id, '/tool eve__tool {"name":"mcp-moy-server__echo","input":{"text":"привет"}}');
    const serialized = JSON.stringify(events);
    expect((await fakeMcpServer.requests()).length).toBeGreaterThan(beforeAgent);
    expect(serialized).toContain("echo: привет");
    expect(serialized).not.toContain("secret-token");
    expect(serialized).not.toContain(upstreamHost);
    const changed = await fetchApp(`/api/mcp-servers/${server.id}`, {
      method: "PATCH", headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(changed.status).toBe(200);
    const disabledCalls = (await fakeMcpServer.requests()).length;
    const disabled = await sendAndWait(user, session.id, '/tool eve__tool {"name":"mcp-moy-server__echo","input":{"text":"пока"}}');
    expect(JSON.stringify(disabled)).not.toContain("echo: пока");
    expect(await fakeMcpServer.requests()).toHaveLength(disabledCalls);
  }, 90_000);

  test("ограничивает проверки и запрещает обращения во внутреннюю сеть", async () => {
    const user = await createUser();
    const cookie = await loginAs(user);
    const create = (url: string) => fetchApp("/api/mcp-servers", {
      method: "POST", headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: url, url, authKind: "none" }),
    });
    expect((await create("http://169.254.169.254/")).status).toBe(400);
    const response = await create(`${upstreamUrl}/mcp`);
    expect(response.status).toBe(201);
    const { id } = await response.json();
    for (let index = 0; index < 6; index++) {
      expect((await fetchApp(`/api/mcp-servers/${id}/check`, { method: "POST", headers: { cookie } })).status).toBe(200);
    }
    expect((await fetchApp(`/api/mcp-servers/${id}/check`, { method: "POST", headers: { cookie } })).status).toBe(429);
    expect((await fetchApp(`/api/mcp-proxy/${id}`, { method: "POST" })).status).toBe(401);
  });

  test("защищает исходящие запросы даже для адреса, записанного непосредственно в базу", async () => {
    const user = await createUser();
    const cookie = await loginAs(user);
    const [server] = await db().insert(mcpServers).values({
      userId: user.id, name: "Внутренний", nameKey: "внутренний", slug: "mcp-internal",
      url: "http://127.0.0.1:1/mcp", authKind: "none",
    }).returning();
    const result = await fetchApp(`/api/mcp-servers/${server.id}/check`, { method: "POST", headers: { cookie } });
    expect(await result.json()).toMatchObject({ ok: false, reason: "blocked_address" });
    const token = await signInternalToken("mcp_proxy", { uid: user.id, srv: server.id });
    const proxy = await fetchApp(`/api/mcp-proxy/${server.id}`, { headers: { "x-studio-mcp-token": token } });
    expect(proxy.status).toBe(502);
    expect(proxy.headers.get("x-studio-proxy-reason")).toBe("blocked_address");
    expect(await fakeMcpServer.requests()).toHaveLength(0);
  });

  test("ограничивает размер непотокового ответа", async () => {
    const user = await createUser();
    const cookie = await loginAs(user);
    const created = await fetchApp("/api/mcp-servers", {
      method: "POST", headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "Большой ответ", url: `${upstreamUrl}/mcp-big`, authKind: "none" }),
    });
    const { id } = await created.json();
    const checked = await fetchApp(`/api/mcp-servers/${id}/check`, { method: "POST", headers: { cookie } });
    expect(await checked.json()).toMatchObject({ ok: false, reason: "too_large" });
    const token = await signInternalToken("mcp_proxy", { uid: user.id, srv: id });
    const proxy = await fetchApp(`/api/mcp-proxy/${id}`, { method: "POST", headers: { "x-studio-mcp-token": token }, body: "{}" });
    expect(proxy.status).toBe(502);
    expect(proxy.headers.get("x-studio-proxy-reason")).toBe("too_large");
  });

  test("отвергает неподдерживаемую авторизацию, повтор и чужой Origin", async () => {
    const user = await createUser();
    const cookie = await loginAs(user);
    const add = (body: object, origin?: string) => fetchApp("/api/mcp-servers", {
      method: "POST", headers: { cookie, "content-type": "application/json", ...(origin ? { origin } : {}) },
      body: JSON.stringify(body),
    });
    const base = { name: "Сервер", url: `${upstreamUrl}/mcp`, authKind: "none" };
    expect((await add({ ...base, authKind: "oauth" })).status).toBe(400);
    expect((await add(base, "https://evil.example")).status).toBe(403);
    expect((await add(base)).status).toBe(201);
    expect((await add({ ...base, name: "сервер", url: `${upstreamUrl}/other` })).status).toBe(409);
    expect((await add({ ...base, name: "Другой" })).status).toBe(409);
    for (let index = 2; index <= 10; index++) {
      expect((await add({ ...base, name: `Сервер ${index}`, url: `${upstreamUrl}/item-${index}` })).status).toBe(201);
    }
    expect((await add({ ...base, name: "Сервер 11", url: `${upstreamUrl}/item-11` })).status).toBe(409);
  });

  test("объясняет отказ и перенаправление сервера", async () => {
    const user = await createUser();
    const cookie = await loginAs(user);
    for (const [path, reason] of [["redirect", "redirect"], ["not-mcp", "not_mcp"], ["forbidden", "forbidden"]] as const) {
      const response = await fetchApp("/api/mcp-servers", {
        method: "POST", headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ name: path, url: `${upstreamUrl}/${path}`, authKind: "none" }),
      });
      const { id } = await response.json();
      const checked = await fetchApp(`/api/mcp-servers/${id}/check`, { method: "POST", headers: { cookie } });
      expect(await checked.json()).toMatchObject({ ok: false, reason });
    }
    const unreachable = await fetchApp("/api/mcp-servers", {
      method: "POST", headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "Нет ответа", url: `http://${loadConfig().ssrfTestAllowHosts[1]}/mcp`, authKind: "none" }),
    });
    const { id } = await unreachable.json();
    const checked = await fetchApp(`/api/mcp-servers/${id}/check`, { method: "POST", headers: { cookie } });
    expect(await checked.json()).toMatchObject({ ok: false, reason: "unreachable" });
  });

  test("проверяет свои заголовки и сообщает об ошибке токена", async () => {
    const user = await createUser();
    const cookie = await loginAs(user);
    const add = async (body: object) => {
      const response = await fetchApp("/api/mcp-servers", {
        method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body),
      });
      expect(response.status).toBe(201);
      return response.json();
    };
    const headers = await add({ name: "Заголовок", url: `${upstreamUrl}/headers`, authKind: "headers", headers: [{ name: "X-Api-Key", value: "k1" }] });
    expect(headers.headerNames).toEqual(["x-api-key"]);
    expect(JSON.stringify(headers)).not.toContain("k1");
    const checked = await fetchApp(`/api/mcp-servers/${headers.id}/check`, { method: "POST", headers: { cookie } });
    expect(await checked.json()).toMatchObject({ ok: true, toolCount: 1 });
    const bearer = await add({ name: "Неверный токен", url: `${upstreamUrl}/bearer`, authKind: "bearer", token: "wrong-token" });
    const rejected = await fetchApp(`/api/mcp-servers/${bearer.id}/check`, { method: "POST", headers: { cookie } });
    expect(await rejected.json()).toMatchObject({ ok: false, reason: "unauthorized" });
    const token = await signInternalToken("mcp_proxy", { uid: user.id, srv: bearer.id });
    const proxy = await fetchApp(`/api/mcp-proxy/${bearer.id}`, {
      method: "POST", headers: { "x-studio-mcp-token": token }, body: "{}",
    });
    expect(proxy.status).toBe(502);
    expect(proxy.headers.get("x-studio-proxy-reason")).toBe("unauthorized");
  });

  test("прокси переписывает SSE и отвергает чужой источник endpoint", async () => {
    const user = await createUser();
    const cookie = await loginAs(user);
    const add = async (path: string) => {
      const response = await fetchApp("/api/mcp-servers", {
        method: "POST", headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ name: path, url: `${upstreamUrl}/${path}`, authKind: "none" }),
      });
      return (await response.json()).id as string;
    };
    const id = await add("sse");
    const token = await signInternalToken("mcp_proxy", { uid: user.id, srv: id });
    const response = await fetchApp(`/api/mcp-proxy/${id}`, { headers: { "x-studio-mcp-token": token } });
    expect(response.headers.get("cache-control")).toBe("no-transform");
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain(`/api/mcp-proxy/${id}/o/messages?sessionId=abc`);
    await reader.cancel();
    const evil = await add("evil");
    const evilToken = await signInternalToken("mcp_proxy", { uid: user.id, srv: evil });
    const denied = await fetchApp(`/api/mcp-proxy/${evil}`, { headers: { "x-studio-mcp-token": evilToken } });
    expect(denied.status).toBe(502);
    expect(denied.headers.get("x-studio-proxy-reason")).toBe("redirect");
    const big = await add("big-sse");
    const bigToken = await signInternalToken("mcp_proxy", { uid: user.id, srv: big });
    const streamed = await fetchApp(`/api/mcp-proxy/${big}`, { headers: { "x-studio-mcp-token": bigToken } });
    expect(await streamed.text()).toContain("x".repeat(100_000));
  });

  test("потоковые события доходят без накопления", async () => {
    const user = await createUser();
    const cookie = await loginAs(user);
    const response = await fetchApp("/api/mcp-servers", {
      method: "POST", headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "Поток событий", url: `${upstreamUrl}/mcp-stream`, authKind: "none" }),
    });
    const { id } = await response.json();
    const token = await signInternalToken("mcp_proxy", { uid: user.id, srv: id });
    const start = performance.now();
    const stream = await fetchApp(`/api/mcp-proxy/${id}`, { headers: { "x-studio-mcp-token": token } });
    const reader = stream.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain("data: test");
    expect(performance.now() - start).toBeLessThan(1_500);
    await reader.cancel();
  });

  test("проверяет SSE-ответ, не ожидая закрытия потока", async () => {
    const user = await createUser();
    const cookie = await loginAs(user);
    const response = await fetchApp("/api/mcp-servers", {
      method: "POST", headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "Поток", url: `${upstreamUrl}/post-sse`, authKind: "none" }),
    });
    const { id } = await response.json();
    const checked = await fetchApp(`/api/mcp-servers/${id}/check`, { method: "POST", headers: { cookie } });
    expect(await checked.json()).toEqual({ ok: true, toolCount: 1, tools: ["echo"] });
  }, 20_000);

  test("агент вызывает инструмент сервера с прежним транспортом SSE", async () => {
    const user = await createUser();
    const cookie = await loginAs(user);
    const response = await fetchApp("/api/mcp-servers", {
      method: "POST", headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "Legacy", url: `${upstreamUrl}/legacy/sse`, authKind: "none" }),
    });
    expect(response.status).toBe(201);
    const server = await response.json();
    const check = await fetchApp(`/api/mcp-servers/${server.id}/check`, { method: "POST", headers: { cookie } });
    expect(await check.json()).toEqual({ ok: true, toolCount: 1, tools: ["echo"] });
    const session = await createSessionAs(user);
    const events = await sendAndWait(user, session.id, '/tool eve__tool {"name":"mcp-legacy__echo","input":{"text":"SSE"}}');
    expect(JSON.stringify(events)).toContain("echo: SSE");
    expect((await fakeMcpServer.requests()).some((request) => request.path.startsWith("/legacy/messages") && request.headers["user-agent"] === "42-ai-studio-mcp/1")).toBe(true);
  }, 90_000);
});
