/** Tavily через HTTP приложения и обычный цикл инструмента eve. */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { MessageStreamEvent } from "eve/client";
import { beforeEach, expect, test } from "vitest";

import { loadConfig } from "../../lib/config";
import { searchWeb } from "../../lib/web/web-search";
import { appOutput } from "./support/app";
import { createSessionAs, eveClientAs, readStreamUntil, sendAndWait } from "./support/chat";
import { createDaytonaKey, createUser } from "./support/db";
import { tavilyStub } from "./support/tavily";
import { TAVILY_RAW_ERROR, type TavilyMode } from "./support/tavily-server";

beforeEach(async () => {
  await createDaytonaKey();
  await tavilyStub.reset();
});

function result(events: readonly MessageStreamEvent[], name = "web_search") {
  const event = events.filter((event) => event.type === "action.result").find(
    (event) => event.data.result.kind === "tool-result" && event.data.result.toolName === name,
  );
  expect(event, `нет результата ${name}`).toBeDefined();
  return event!.data;
}

function output(events: readonly MessageStreamEvent[], name = "web_search"): Record<string, unknown> {
  const data = result(events, name);
  expect(data.status).toBe("completed");
  return data.result.kind === "tool-result" ? data.result.output as Record<string, unknown> : {};
}

function expectNoSecrets(events: readonly MessageStreamEvent[]) {
  for (const text of [JSON.stringify(events), appOutput()]) {
    expect(text).not.toContain("tvly-test-key");
    expect(text).not.toContain(TAVILY_RAW_ERROR);
  }
}

async function runSearch(input: Record<string, unknown> = { query: "remotion captions", maxResults: 3 }) {
  const user = await createUser();
  const { id } = await createSessionAs(user);
  return sendAndWait(user, id, `/tool web_search ${JSON.stringify(input)}`);
}

test("поиск возвращает три источника и передаёт Tavily только нужные параметры", async () => {
  const events = await runSearch();
  expect(output(events)).toMatchObject({
    query: "remotion captions", requestId: "tavily-request-1",
    results: [
      { title: "Captions", url: "https://www.remotion.dev/docs/captions", host: "www.remotion.dev", snippet: "Субтитры и время каждого слова.", publishedDate: null, score: 0.95 },
      expect.objectContaining({ title: "Sequence", host: "www.remotion.dev" }),
      expect.objectContaining({ title: "Audio", host: "www.remotion.dev" }),
    ],
  });
  const calls = await tavilyStub.calls();
  expect(calls).toHaveLength(1);
  expect(calls[0]?.headers.authorization).toBe("Bearer tvly-test-key");
  expect(calls[0]?.body).toEqual({
    query: "remotion captions", max_results: 3, search_depth: "basic", topic: "general",
    include_answer: false, include_raw_content: false, include_images: false, chunks_per_source: 3,
  });
  expect(events.filter((event) => event.type === "message.completed").at(-1)?.data.message).toBe("готово");
  expect(JSON.stringify(events)).toContain("Найдено источников: 3");
  expectNoSecrets(events);
});

test("новости, период, домены и advanced доходят до API", async () => {
  const events = await runSearch({ query: "remotion", topic: "news", timeRange: "week", includeDomains: ["remotion.dev"], depth: "advanced", maxResults: 1 });
  expect(output(events).results).toEqual([expect.objectContaining({ publishedDate: "2026-11-04" })]);
  expect((await tavilyStub.calls())[0]?.body).toMatchObject({ topic: "news", time_range: "week", include_domains: ["remotion.dev"], search_depth: "advanced", max_results: 1 });
});

test("429 дважды с Retry-After: 1, затем успех", async () => {
  await tavilyStub.setMode("429", 2);
  const events = await runSearch();
  expect(output(events).results).toHaveLength(3);
  const calls = await tavilyStub.calls();
  expect(calls).toHaveLength(3);
  expect(calls[1]!.at - calls[0]!.at).toBeGreaterThanOrEqual(950);
  expect(calls[2]!.at - calls[1]!.at).toBeGreaterThanOrEqual(950);
  expectNoSecrets(events);
});

test.each([
  ["401", "Поиск отклонил ключ доступа", 1, "web_search_auth"],
  ["432", "Лимит поиска исчерпан", 1, "web_search_quota"],
  ["433", "Лимит поиска исчерпан", 1, "web_search_quota"],
  ["400", "Поиск не принял запрос", 1, "web_search_bad_request"],
  ["422", "Поиск не принял запрос", 1, "web_search_bad_request"],
  ["429", "Поиск ограничил частоту запросов", 3, "web_search_rate_limited"],
  ["500", "Поиск сейчас недоступен", 3, "web_search_unavailable"],
  ["non_json", "Поиск сейчас недоступен", 3, "web_search_unavailable"],
  ["invalid_payload", "Поиск сейчас недоступен", 3, "web_search_unavailable"],
] as const)("ответ Tavily %s превращается в безопасную ошибку", async (mode, message, attempts, code) => {
  await tavilyStub.setMode(mode satisfies TavilyMode);
  const events = await runSearch();
  const data = result(events);
  expect(data.status).toBe("failed");
  expect(data.error?.message).toContain(message);
  expect(await tavilyStub.calls()).toHaveLength(attempts);
  expect(appOutput()).toContain(code);
  expect(appOutput()).toContain("tavily-request-1");
  expectNoSecrets(events);
});

test("пустая выдача успешна, без ключа функция не отправляет запрос", async () => {
  await tavilyStub.setMode("empty");
  const events = await runSearch();
  expect(output(events).results).toEqual([]);
  await tavilyStub.reset();
  await expect(searchWeb({ query: "remotion" }, {
    apiKey: undefined, apiUrl: loadConfig().tavilyApiUrl,
  })).rejects.toMatchObject({ code: "web_search_not_configured", message: expect.stringContaining("не задан ключ") });
  expect(await tavilyStub.calls()).toEqual([]);
  expectNoSecrets(events);
});

test("обе tools подменяются stubs без запроса к Tavily", async () => {
  const user = await createUser();
  const { id } = await createSessionAs(user);
  const client = await eveClientAs(user, id);
  const search = { query: "stub", requestId: "stub-request", results: [] };
  const page = {
    url: "https://example.com/", finalUrl: "https://example.com/", title: "Подмена страницы", byline: null,
    siteName: null, publishedTime: null, lang: "ru", contentType: "text/plain", extraction: "raw",
    content: "Текст подмены страницы.", offset: 0, nextOffset: null, totalChars: 22,
  };
  const created = await client.sessions.create({
    message: '/tool web_search {"query":"stub"}',
    stubs: [
      { id: "search", tool: "web_search", outcome: { response: search } },
      { id: "page", tool: "read_page", outcome: { response: page } },
    ],
  });
  const searchEvents = await readStreamUntil(created.response, "session.waiting");
  expect(output(searchEvents)).toEqual(search);
  const pageEvents = await readStreamUntil(await created.session.send('/tool read_page {"url":"https://example.com/"}'), "session.waiting");
  expect(output(pageEvents, "read_page")).toEqual(page);
  expect(await tavilyStub.calls()).toEqual([]);
  expectNoSecrets([...searchEvents, ...pageEvents]);
});

test("read_page не соединяется с локальным сервером и адресом метаданных", async () => {
  let connections = 0;
  const trap = createServer((_request, response) => response.end("Нельзя читать эту страницу"));
  trap.on("connection", () => { connections += 1; });
  await new Promise<void>((resolve, reject) => {
    trap.once("error", reject);
    trap.listen(0, "127.0.0.1", resolve);
  });
  try {
    const port = (trap.address() as AddressInfo).port;
    const user = await createUser();
    const { id } = await createSessionAs(user);
    for (const url of [`http://127.0.0.1:${port}/`, `http://localhost:${port}/`, `http://[::1]:${port}/`, "http://169.254.169.254/"]) {
      const events = await sendAndWait(user, id, `/tool read_page ${JSON.stringify({ url })}`);
      const read = result(events, "read_page");
      expect(read.status).toBe("failed");
      expect(read.error?.message).toContain("внутренней сети");
      expectNoSecrets(events);
    }
    expect(connections).toBe(0);
  } finally {
    await new Promise<void>((resolve, reject) => trap.close((error) => error ? reject(error) : resolve()));
  }
});
