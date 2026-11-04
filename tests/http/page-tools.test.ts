/**
 * Проверка адреса и чтение страницы без приложения: локальный сервер
 * разрешается только через allowHosts, внутренняя сеть не получает соединения.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { expect, test } from "vitest";

import { isBlockedIp, parseOutboundUrl } from "../../lib/web/public-url";
import { PageToolError, readPage } from "../../lib/web/read-page";
import { searchWeb } from "../../lib/web/web-search";

const MARKDOWN = `${"# Заголовок\n\n"}${"Строка документации Remotion для проверки чтения. ".repeat(4)}`;

function listen(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ port: number; hits: () => number; close: () => Promise<void> }> {
  const server = createServer(handler);
  let connections = 0;
  server.on("connection", () => {
    connections += 1;
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolve({
        port: address.port,
        hits: () => connections,
        close: () => new Promise((done, fail) => {
          server.close((error) => (error ? fail(error) : done()));
        }),
      });
    });
  });
}

test("разбор адреса отвергает внутреннюю сеть и пропускает публичные адреса", () => {
  const blocked = [
    "http://127.0.0.1/",
    "http://2130706433/",
    "http://0x7f.1/",
    "http://017700000001/",
    "http://127.1/",
    "http://0/",
    "http://[::1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://[::ffff:7f00:1]/",
    "http://[::ffff:8.8.8.8]/",
    "http://169.254.169.254/latest/meta-data/",
    "http://[fd00:ec2::254]/",
    "http://100.100.100.200/",
    "http://10.1.2.3/",
    "http://172.31.255.255/",
    "http://192.168.1.1/",
    "http://[64:ff9b::7f00:1]/",
    "http://[2002:7f00:1::]/",
    "http://localhost./",
    "http://LOCALHOST/",
    "http://service.internal/",
    "http://intranet/",
  ];
  for (const url of blocked) {
    expect(parseOutboundUrl(url), url).toEqual({ ok: false, reason: "blocked_address" });
  }
  const bad = ["file:///etc/passwd", "ftp://example.com/", "http://user:pw@example.com/", "http://example.com:8080/"];
  for (const url of bad) {
    expect(parseOutboundUrl(url), url).toEqual({ ok: false, reason: "bad_url" });
  }
  expect(parseOutboundUrl("http://127.0.0.1:80@evil.com/")).toEqual({ ok: false, reason: "bad_url" });
  for (const url of ["https://example.com/", "http://8.8.8.8/", "http://172.32.0.1/", "http://[2606:4700:4700::1111]/", "http://exa%6dple.com/"]) {
    expect(parseOutboundUrl(url).ok, url).toBe(true);
  }
  expect(parseOutboundUrl("http://exa%6dple.com/").ok && (parseOutboundUrl("http://exa%6dple.com/") as { url: URL }).url.hostname).toBe("example.com");
  expect(isBlockedIp("8.8.8.8")).toBe(false);
  expect(isBlockedIp("127.0.0.1")).toBe(true);
});

test("локальный сервер без allowHosts не получает соединения", async () => {
  const server = await listen((_req, res) => {
    res.end(MARKDOWN);
  });
  try {
    await expect(readPage({ url: `http://127.0.0.1:${server.port}/` })).rejects.toMatchObject({
      code: "read_page_blocked_address",
    });
    await expect(readPage({ url: `http://localhost:${server.port}/` })).rejects.toMatchObject({
      code: "read_page_blocked_address",
    });
    expect(server.hits()).toBe(0);
  } finally {
    await server.close();
  }
});

test("цепочка перенаправлений, типы и продолжение читаются через allowHosts", async () => {
  const long = `${"абзац текста\n\n".repeat(4000)}конец`;
  const windows = Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2, 0x20]);
  const padded = Buffer.concat([windows, Buffer.from("x".repeat(80))]);
  const server = await listen((req, res) => {
    const path = req.url ?? "/";
    if (path === "/a") {
      res.writeHead(302, { Location: "/b" });
      res.end();
      return;
    }
    if (path === "/b") {
      res.writeHead(301, { Location: "/c" });
      res.end();
      return;
    }
    if (path === "/c") {
      expect(req.headers.cookie).toBeUndefined();
      expect(req.headers.authorization).toBeUndefined();
      expect(req.headers.referer).toBeUndefined();
      res.writeHead(200, { "Content-Type": "text/markdown; charset=utf-8" });
      res.end(MARKDOWN);
      return;
    }
    if (path === "/loop") {
      res.writeHead(302, { Location: "/loop" });
      res.end();
      return;
    }
    if (path.startsWith("/hop/")) {
      const step = Number(path.slice("/hop/".length));
      res.writeHead(302, { Location: `/hop/${step + 1}` });
      res.end();
      return;
    }
    if (path === "/meta") {
      res.writeHead(302, { Location: "http://169.254.169.254/" });
      res.end();
      return;
    }
    if (path === "/ftp") {
      res.writeHead(302, { Location: "ftp://files.example/" });
      res.end();
      return;
    }
    if (path === "/cp1251") {
      res.writeHead(200, { "Content-Type": "text/plain; charset=windows-1251" });
      res.end(padded);
      return;
    }
    if (path === "/meta-charset") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(Buffer.concat([
        Buffer.from("<meta charset=\"windows-1251\"><title>Encoding</title><p>", "ascii"),
        padded,
        Buffer.from("</p>", "ascii"),
      ]));
      return;
    }
    if (path === "/pdf") {
      res.writeHead(200, { "Content-Type": "application/pdf" });
      res.end("%PDF-1.4");
      return;
    }
    if (path === "/md404") {
      const accept = req.headers.accept ?? "";
      if (accept.startsWith("text/markdown")) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("no");
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<title>Страница</title><p>${"Видимый текст страницы без markdown. ".repeat(4)}</p>`);
      return;
    }
    if (path === "/long") {
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(long);
      return;
    }
    if (path === "/huge") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(Buffer.alloc(5 * 1024 * 1024 + 1, 97));
      return;
    }
    res.writeHead(404);
    res.end("missing");
  });
  const policy = { allowHosts: [`127.0.0.1:${server.port}`] };
  const base = `http://127.0.0.1:${server.port}`;
  try {
    const page = await readPage({ url: `${base}/a` }, policy);
    expect(page.finalUrl).toBe(`${base}/c`);
    expect(page.extraction).toBe("raw");
    expect(page.title).toBe("Заголовок");
    expect(page.content).toContain("Строка документации");

    await expect(readPage({ url: `${base}/loop` }, policy)).rejects.toMatchObject({ code: "read_page_redirect_loop" });
    await expect(readPage({ url: `${base}/hop/0` }, policy)).rejects.toMatchObject({ code: "read_page_too_many_redirects" });
    await expect(readPage({ url: `${base}/meta` }, policy)).rejects.toMatchObject({ code: "read_page_blocked_address" });
    await expect(readPage({ url: `${base}/ftp` }, policy)).rejects.toMatchObject({ code: "read_page_bad_url" });

    const encoded = await readPage({ url: `${base}/cp1251` }, policy);
    expect(encoded.content.startsWith("Привет")).toBe(true);
    const meta = await readPage({ url: `${base}/meta-charset` }, policy);
    expect(meta.content).toContain("Привет");
    await expect(readPage({ url: `${base}/pdf` }, policy)).rejects.toMatchObject({ code: "read_page_unsupported_type" });

    const html = await readPage({ url: `${base}/md404` }, policy);
    expect(html.extraction).toBe("page");
    expect(html.title).toBe("Страница");

    const first = await readPage({ url: `${base}/long`, offset: 0, maxChars: 1000 }, policy);
    let combined = first.content;
    let next = first.nextOffset;
    for (let guard = 0; next !== null && guard < 100; guard += 1) {
      const part = await readPage({ url: `${base}/long`, offset: next, maxChars: 1000 }, policy);
      combined += part.content;
      next = part.nextOffset;
    }
    expect(next).toBeNull();
    expect(combined.length).toBe(first.totalChars);

    await expect(readPage({ url: `${base}/huge` }, policy)).rejects.toMatchObject({ code: "read_page_too_large" });
  } finally {
    await server.close();
  }
});

test("подмена DNS не пускает адрес, у которого есть внутренний IP", async () => {
  let calls = 0;
  await expect(readPage(
    { url: "http://example.com/docs" },
    { resolveDns: async () => ["8.8.8.8", "10.0.0.5"] },
  )).rejects.toMatchObject({ code: "read_page_blocked_address" });

  await expect(readPage(
    { url: "http://example.com/docs" },
    {
      resolveDns: async () => {
        calls += 1;
        return calls === 1 ? ["8.8.8.8"] : ["127.0.0.1"];
      },
    },
  )).rejects.toBeInstanceOf(PageToolError);
  expect(calls).toBeGreaterThanOrEqual(2);
});

test("поиск без ключа не ходит в сеть и переводит ответы Tavily", async () => {
  const seen: { authorization?: string; body?: unknown }[] = [];
  let mode = "ok";
  const server = await listen(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString("utf8");
    seen.push({
      authorization: req.headers.authorization,
      body: raw === "" ? undefined : JSON.parse(raw),
    });
    if (mode === "401") {
      res.writeHead(401);
      res.end("{}");
      return;
    }
    if (mode === "432") {
      res.writeHead(432);
      res.end("{}");
      return;
    }
    if (mode === "400") {
      res.writeHead(400);
      res.end("{}");
      return;
    }
    if (mode === "500") {
      res.writeHead(500);
      res.end("{}");
      return;
    }
    if (mode === "429") {
      res.writeHead(429, { "Retry-After": "0" });
      res.end("{}");
      return;
    }
    if (mode === "text") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("not-json");
      return;
    }
    if (mode === "empty") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ request_id: "empty", results: [] }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      request_id: "req-1",
      results: [
        { title: "Captions", url: "https://www.remotion.dev/docs/captions", content: "word timings", score: 0.9 },
        { title: "Sequence", url: "https://www.remotion.dev/docs/sequence", content: "sequence", score: 0.5 },
        { title: "Audio", url: "https://www.remotion.dev/docs/audio", content: "audio", score: 0.4 },
      ],
    }));
  });
  const immediate = async () => {};
  try {
    await expect(searchWeb(
      { query: "remotion" },
      { apiKey: undefined, apiUrl: `http://127.0.0.1:${server.port}`, sleep: immediate },
    )).rejects.toMatchObject({ code: "web_search_not_configured" });
    expect(server.hits()).toBe(0);

    const found = await searchWeb(
      { query: "remotion captions", maxResults: 3 },
      { apiKey: "tvly-test-key", apiUrl: `http://127.0.0.1:${server.port}`, sleep: immediate },
    );
    expect(found.results).toHaveLength(3);
    expect(found.results[0]?.host).toBe("www.remotion.dev");
    expect(seen[0]?.authorization).toBe("Bearer tvly-test-key");
    expect(seen[0]?.body).toMatchObject({
      query: "remotion captions",
      max_results: 3,
      search_depth: "basic",
      topic: "general",
      include_answer: false,
      include_raw_content: false,
      include_images: false,
      chunks_per_source: 3,
    });

    mode = "401";
    await expect(searchWeb(
      { query: "x" },
      { apiKey: "tvly-test-key", apiUrl: `http://127.0.0.1:${server.port}`, sleep: immediate },
    )).rejects.toMatchObject({ code: "web_search_auth" });
    mode = "432";
    await expect(searchWeb(
      { query: "x" },
      { apiKey: "tvly-test-key", apiUrl: `http://127.0.0.1:${server.port}`, sleep: immediate },
    )).rejects.toMatchObject({ code: "web_search_quota" });
    mode = "400";
    await expect(searchWeb(
      { query: "x" },
      { apiKey: "tvly-test-key", apiUrl: `http://127.0.0.1:${server.port}`, sleep: immediate },
    )).rejects.toMatchObject({ code: "web_search_bad_request" });
    mode = "500";
    await expect(searchWeb(
      { query: "x" },
      { apiKey: "tvly-test-key", apiUrl: `http://127.0.0.1:${server.port}`, sleep: immediate },
    )).rejects.toMatchObject({ code: "web_search_unavailable" });
    mode = "429";
    await expect(searchWeb(
      { query: "x" },
      { apiKey: "tvly-test-key", apiUrl: `http://127.0.0.1:${server.port}`, sleep: immediate },
    )).rejects.toMatchObject({ code: "web_search_rate_limited" });
    mode = "text";
    await expect(searchWeb(
      { query: "x" },
      { apiKey: "tvly-test-key", apiUrl: `http://127.0.0.1:${server.port}`, sleep: immediate },
    )).rejects.toMatchObject({ code: "web_search_unavailable" });
    mode = "empty";
    const empty = await searchWeb(
      { query: "x" },
      { apiKey: "tvly-test-key", apiUrl: `http://127.0.0.1:${server.port}`, sleep: immediate },
    );
    expect(empty.results).toEqual([]);
    expect(JSON.stringify(seen)).not.toContain("should-not-leak");
  } finally {
    await server.close();
  }
});
