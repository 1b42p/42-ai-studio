import { once } from "node:events";
import { createServer } from "node:http";
import { gzipSync } from "node:zlib";
import { getDefaultAutoSelectFamily, setDefaultAutoSelectFamily, type AddressInfo } from "node:net";
import { fetch as undiciFetch } from "undici";

import { expect, test } from "vitest";

import { createSafeAgent, isBlockedIp, parseOutboundUrl, safeFetch, type OutboundPolicy } from "../../lib/web/safe-fetch";

const policy: OutboundPolicy = {
  schemes: ["http:", "https:"], ports: "web", maxRedirects: 5,
  timeoutMs: 1000, maxBytes: 1024,
};

test("единая политика адресов запрещает внутренние диапазоны, но не публичный IPv4", () => {
  for (const host of ["127.0.0.1", "2130706433", "0x7f.1", "017700000001", "127.1", "0", "[::1]", "[::ffff:8.8.8.8]", "[::ffff:7f00:1]", "[::127.0.0.1]", "169.254.169.254", "[fd00:ec2::254]", "100.100.100.200", "10.1.2.3", "172.31.255.255", "192.168.1.1", "[64:ff9b::7f00:1]", "[2002:7f00:1::]", "localhost.", "LOCALHOST", "service.internal", "intranet"]) {
    expect(parseOutboundUrl(`http://${host}:8080/`, policy), host).toEqual({ ok: false, reason: "blocked_address" });
  }
  for (const url of ["file:///etc/passwd", "ftp://example.com", "http://user:pw@example.com", "http://example.com:8080", "http://example.com:0", "http://127.0.0.1:80@evil.com/"]) {
    expect(parseOutboundUrl(url, policy), url).toEqual({ ok: false, reason: "bad_url" });
  }
  for (const host of ["example.com", "8.8.8.8", "172.32.0.1", "[2606:4700:4700::1111]", "exa%6dple.com"]) {
    expect(parseOutboundUrl(`http://${host}/`, policy).ok, host).toBe(true);
  }
  expect(isBlockedIp("8.8.8.8")).toBe(false);
  expect(isBlockedIp("::ffff:808:808")).toBe(true);
  for (const ip of ["0.255.255.255", "10.255.255.255", "100.127.255.255", "127.255.255.255", "169.254.255.255", "172.31.255.255", "192.0.0.255", "192.0.2.255", "192.88.99.255", "192.168.255.255", "198.19.255.255", "198.51.100.255", "203.0.113.255", "239.255.255.255", "255.255.255.255", "2001:1ff::1", "2001:db8::1", "2002:ffff::1", "3fff:fff::1", "4000::1", "8000::1", "64:ff9b:1::1", "100::1", "5f00::1", "fc00::1", "fe80::1", "fec0::1", "ff00::1"]) {
    expect(isBlockedIp(ip), ip).toBe(true);
  }
  expect(parseOutboundUrl("https://example.com:8443", { ...policy, ports: "any" }).ok).toBe(true);
});

test("createSafeAgent соединяется через проверенный lookup с all:true и all:false", async () => {
  const server = createServer((_req, res) => res.end("проверенный DNS"));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  const previous = getDefaultAutoSelectFamily();
  let resolutions = 0;
  try {
    for (const all of [true, false]) {
      setDefaultAutoSelectFamily(all);
      const agent = createSafeAgent({
        ...policy, allowHosts: [`test.example:${port}`],
        resolveDns: async () => { resolutions += 1; return ["127.0.0.1"]; },
      });
      try {
        const response = await undiciFetch(`http://test.example:${port}`, { dispatcher: agent });
        expect(await response.text()).toBe("проверенный DNS");
      } finally { await agent.destroy(); }
    }
    expect(resolutions).toBe(2);
  } finally {
    setDefaultAutoSelectFamily(previous);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("защищённый запрос проверяет каждый переход и ограничивает распакованное тело", async () => {
  let connections = 0;
  const server = createServer((req, res) => {
    expect(req.headers.cookie).toBeUndefined();
    expect(req.headers.authorization).toBeUndefined();
    expect(req.headers.referer).toBeUndefined();
    if (req.url === "/a") res.writeHead(302, { Location: "/b" }).end();
    else if (req.url === "/b") res.writeHead(301, { Location: "done" }).end();
    else if (req.url === "/loop") res.writeHead(302, { Location: "/loop#other" }).end();
    else if (req.url === "/private") res.writeHead(302, { Location: "http://169.254.169.254/" }).end();
    else if (req.url === "/ftp") res.writeHead(302, { Location: "ftp://example.com/" }).end();
    else if (req.url?.startsWith("/hop/")) res.writeHead(302, { Location: `/hop/${Number(req.url.split("/").at(-1)) + 1}` }).end();
    else if (req.url === "/gzip") res.writeHead(200, { "Content-Encoding": "gzip" }).end(gzipSync("x".repeat(1025)));
    else res.end("готово");
  });
  server.on("connection", () => { connections += 1; });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  const allowed = { ...policy, allowHosts: [`127.0.0.1:${port}`] };
  try {
    for (const host of ["127.0.0.1", "localhost", "[::1]"]) {
      await expect(safeFetch(`http://${host}:${port}`, {}, policy)).rejects.toMatchObject({ reason: "blocked_address" });
    }
    expect(connections).toBe(0);
    const result = await safeFetch(`${base}/a`, {}, allowed);
    expect(result.finalUrl).toBe(`${base}/done`);
    expect(result.body.toString()).toBe("готово");
    await expect(safeFetch(`${base}/loop`, {}, allowed)).rejects.toMatchObject({ reason: "redirect_loop" });
    await expect(safeFetch(`${base}/private`, {}, allowed)).rejects.toMatchObject({ reason: "blocked_address" });
    await expect(safeFetch(`${base}/ftp`, {}, allowed)).rejects.toMatchObject({ reason: "bad_url" });
    await expect(safeFetch(`${base}/hop/0`, {}, allowed)).rejects.toMatchObject({ reason: "too_many_redirects" });
    await expect(safeFetch(`${base}/a`, {}, { ...allowed, maxRedirects: 0 })).rejects.toMatchObject({ reason: "redirect" });
    await expect(safeFetch(`${base}/gzip`, {}, allowed)).rejects.toMatchObject({ reason: "too_large" });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("проверка DNS не допускает смешанные ответы и повторную привязку к localhost при соединении", async () => {
  await expect(safeFetch("http://example.com/", {}, {
    ...policy, resolveDns: async () => ["8.8.8.8", "10.0.0.5"],
  })).rejects.toMatchObject({ reason: "blocked_address" });
  let resolutions = 0;
  await expect(safeFetch("http://example.com/", {}, {
    ...policy,
    resolveDns: async () => ++resolutions === 1 ? ["8.8.8.8"] : ["127.0.0.1"],
  })).rejects.toMatchObject({ reason: "blocked_address" });
  expect(resolutions).toBe(2);
  await expect(safeFetch("http://example.com/", {}, {
    ...policy, resolveDns: async () => [],
  })).rejects.toMatchObject({ reason: "dns_not_found" });
  await expect(safeFetch("http://example.com/", {}, {
    ...policy, timeoutMs: 20, resolveDns: () => new Promise(() => {}),
  })).rejects.toMatchObject({ reason: "timeout" });
});
