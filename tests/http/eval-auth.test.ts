/** Eval-принципал проверяется через настоящий HTTP, хуки и тестовую БД. */
import { Client } from "eve/client";
import { afterAll, describe, expect, inject, test } from "vitest";

import { authenticateEval } from "../../agent/lib/eval-auth";
import { loadConfig } from "../../lib/config";
import { appOutput, fetchApp } from "./support/app";
import { loginAs } from "./support/auth";
import { createSessionAs, eveClientAs, waitForStoredEvents } from "./support/chat";
import { createUser } from "./support/db";

function evalToken(): string {
  const token = loadConfig().eveEvalAuthToken;
  if (token === undefined) throw new Error("HTTP-тестам нужен EVE_EVAL_AUTH_TOKEN из .env.test");
  return token;
}

const TOKEN = evalToken();
const SEARCH_OUTPUT = {
  query: "проверка eval",
  requestId: "eval-auth-stub-only",
  results: [{
    title: "Eval stub", url: "https://example.com/eval-stub", host: "example.com",
    snippet: "Этот результат существует только в подмене eval.", publishedDate: null, score: 1,
  }],
};
const STUBS = [{ id: "eval-search", tool: "web_search", outcome: { response: SEARCH_OUTPUT } }];

describe("локальный eval bearer по HTTP", () => {
  // Канал и фикстурная модель работают в primary, поднятом global setup.
  const client = new Client({ host: inject("appUrl"), auth: { bearer: TOKEN }, redirect: "manual" });

  afterAll(() => {
    // Булева проверка не раскрывает токен даже в сообщении об ошибке теста.
    expect(appOutput().includes(TOKEN)).toBe(false);
  });

  function request(path: string, init: RequestInit = {}, token: string | null = TOKEN) {
    const headers = new Headers(init.headers);
    if (token !== null) headers.set("authorization", `Bearer ${token}`);
    return fetchApp(path, { ...init, headers });
  }

  test("допускает верный bearer; отсутствующий и неверный не дают ни доступа, ни подмен", async () => {
    expect((await request("/eve/v1/info")).status).toBe(200);
    for (const token of [null, "wrong-eval-token", "0".repeat(TOKEN.length)]) {
      expect((await request("/eve/v1/info", {}, token)).status).toBe(401);
      const response = await request("/eve/v1/session", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "привет", stubs: STUBS }),
      }, token);
      expect(response.status).toBe(401);
    }
  });

  test("подменяет инструмент и завершает ход без сессии приложения и пользовательских событий", async () => {
    const user = await createUser();
    const cookie = await loginAs(user);
    const { id } = await createSessionAs(user);
    const userRequest = (path: string) => fetchApp(path, { headers: { cookie } });
    const before = await userRequest(`/api/sessions/${id}/events`);
    expect(before.status).toBe(200);
    expect(await before.json()).toEqual({ events: [], cursor: 0 });

    // Нет cookie и x-studio-session-id: у eval нет пользовательской привязки.
    const { session, response } = await client.sessions.create({
      message: '/tool web_search {"query":"проверка eval"}', stubs: STUBS,
    });
    const result = await response.result();
    expect(result.status).toBe("waiting");
    expect(result.message).toBe("готово");
    const tool = result.events.find((event) => event.type === "action.result" &&
      event.data.result.kind === "tool-result" && event.data.result.toolName === "web_search");
    expect(tool?.data).toMatchObject({
      status: "completed", result: { kind: "tool-result", output: SEARCH_OUTPUT },
    });
    const continued = await (await session.send("ещё один ход eval")).result();
    expect(continued.status).toBe("waiting");
    expect(continued.message).toBe("Эхо: ещё один ход eval");

    const state = await userRequest(`/api/sessions/${id}`);
    expect(state.status).toBe(200);
    expect(await state.json()).toMatchObject({ id, eveSessionId: null, streamCursor: 0 });
    const after = await userRequest(`/api/sessions/${id}/events`);
    expect(after.status).toBe(200);
    expect(await after.json()).toEqual({ events: [], cursor: 0 });
    const listed = await userRequest("/api/sessions");
    expect(listed.status).toBe(200);
    expect(await listed.json()).toMatchObject({ items: [] });
  }, 60_000);

  test("eval не читает и не меняет пользовательские корни и копии, пользователь не читает eval", async () => {
    const user = await createUser();
    const cookie = await loginAs(user);
    const { id } = await createSessionAs(user);
    const userClient = await eveClientAs(user, id);
    const created = await userClient.sessions.create({ message: '/tool agent {"message":"привет"}' });
    const root = await created.response.result();
    expect(root.status).toBe("waiting");
    const copy = root.events.find((event) => event.type === "agent.started");
    if (copy === undefined) throw new Error("Пользовательская копия не объявлена");
    // Хук может дописать последнюю границу уже после получения ответа клиентом.
    await waitForStoredEvents(user, id, (events) =>
      events.some((event) => event.payload.type === "session.waiting"));
    const storedBefore = await fetchApp(`/api/sessions/${id}/events`, { headers: { cookie } });
    expect(storedBefore.status).toBe(200);
    const stored = await storedBefore.json();

    for (const sessionId of [root.sessionId, copy.data.sessionId]) {
      // Даже cookie владельца не превращает запрос eval в пользовательский.
      for (const headers of [new Headers(), new Headers({ cookie })]) {
        const stream = await request(`/eve/v1/session/${sessionId}/stream?follow=false`, { headers });
        expect(stream.status).toBe(403);
        expect(await stream.json()).toMatchObject({ code: "session_forbidden" });
      }
      for (const suffix of ["", "/cancel", "/clear", "/compact", "/reset"]) {
        const denied = await request(`/eve/v1/session/${sessionId}${suffix}`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ message: "не менять историю" }),
        });
        expect(denied.status).toBe(403);
        expect(await denied.json()).toMatchObject({ code: "session_forbidden" });
      }
    }
    const storedAfter = await fetchApp(`/api/sessions/${id}/events`, { headers: { cookie } });
    expect(storedAfter.status).toBe(200);
    expect(await storedAfter.json()).toEqual(stored);
    const userTurn = await (await created.session.send("история доступна владельцу")).result();
    expect(userTurn.message).toBe("Эхо: история доступна владельцу");

    const evaluation = await client.sessions.create({ message: "изолированный eval" });
    const evalTurn = await evaluation.response.result();
    expect(evalTurn.status).toBe("waiting");
    const denied = await fetchApp(`/eve/v1/session/${evalTurn.sessionId}/stream?follow=false`, {
      headers: { cookie },
    });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ code: "session_forbidden" });
  }, 90_000);
});

describe("ограничения eval-аутентификации", () => {
  test("запрещает production, выключенный режим, отсутствие секрета и публичный адрес", () => {
    const config = { appEvalMode: true, eveEvalAuthToken: TOKEN, appUrl: "http://localhost:3100" };
    const request = (url = "http://localhost:3100/eve/v1/info") => new Request(url, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(authenticateEval(request(), config, "development")).not.toBeNull();
    expect(authenticateEval(request(), config, "production")).toBeNull();
    expect(authenticateEval(request(), { ...config, appEvalMode: false }, "development")).toBeNull();
    expect(authenticateEval(request(), { ...config, eveEvalAuthToken: undefined }, "development")).toBeNull();
    expect(authenticateEval(request(), { ...config, eveEvalAuthToken: "short" }, "development")).toBeNull();
    expect(authenticateEval(request(), { ...config, appUrl: "https://example.com" }, "development")).toBeNull();
    expect(authenticateEval(request("https://example.com/eve/v1/info"), config, "development")).toBeNull();
  });
});
