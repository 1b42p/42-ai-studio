import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, request, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { pipeline, type Duplex } from "node:stream";

import { resolveOutboundAddress, SafeFetchError, type OutboundPolicy } from "../web/safe-fetch";

export const DOWNLOAD_POLICY: OutboundPolicy = {
  schemes: ["http:", "https:"],
  ports: "web",
  maxRedirects: 0,
  timeoutMs: 10_000,
  maxBytes: 1,
};

type ResolveDns = OutboundPolicy["resolveDns"];
type Target = Awaited<ReturnType<typeof resolveOutboundAddress>>;

async function resolveTarget(raw: string, scheme: "http:" | "https:", resolveDns: ResolveDns, signal: AbortSignal) {
  if (!raw.startsWith(`${scheme}//`) || /[\\\s]/.test(raw)) throw new SafeFetchError("bad_url");
  const url = URL.parse(raw);
  if (!url || url.protocol !== scheme || url.username || url.password || url.hash) throw new SafeFetchError("bad_url");
  // Ограничение длины общего URL-парсера применяется к origin, а не к CDN-подписям.
  const target = await resolveOutboundAddress(url.origin, { ...DOWNLOAD_POLICY, resolveDns }, signal);
  return { ...target, url };
}

function connectTarget({ url, addresses }: Target): Socket {
  const socket = createConnection({
    host: "download.invalid",
    port: url.protocol === "https:" ? 443 : 80,
    autoSelectFamily: true,
    // Только снимок проверенного DNS; системное разрешение здесь не вызывается.
    lookup(_hostname, options, callback) {
      if (options.all) callback(null, addresses);
      else callback(null, addresses[0].address, addresses[0].family);
    },
  });
  return socket.setTimeout(20_000, () => socket.destroy());
}

function endToEndHeaders(input: IncomingHttpHeaders): IncomingHttpHeaders {
  const headers = { ...input };
  for (const name of [
    ...String(headers.connection ?? "").toLowerCase().split(",").map((token) => token.trim()),
    "connection", "proxy-connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailer", "transfer-encoding", "upgrade", "expect",
  ]) delete headers[name];
  return headers;
}

function forward(req: IncomingMessage, res: ServerResponse, target: Target, signal: AbortSignal): void {
  const upstream = request({
    method: req.method,
    path: target.url.pathname + target.url.search,
    headers: { ...endToEndHeaders(req.headers), host: target.url.host },
    signal,
    createConnection: () => connectTarget(target),
  }, (response) => {
    res.writeHead(response.statusCode ?? 502, endToEndHeaders(response.headers));
    pipeline(response, res, () => {});
  });
  res.once("close", () => upstream.destroy());
  upstream.on("error", () => {
    if (!res.headersSent) res.writeHead(502).end();
    else res.destroy();
  });
  req.once("error", () => upstream.destroy());
  req.pipe(upstream);
}

function tunnel(client: Duplex, head: Buffer, target: Target): void {
  const upstream = connectTarget(target);
  let connected = false;
  client.once("close", () => upstream.destroy());
  upstream.once("connect", () => {
    connected = true;
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length) upstream.write(head);
    client.pipe(upstream).pipe(client);
  });
  upstream.once("error", () => {
    if (!connected) client.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
    else client.destroy();
  });
  upstream.once("close", () => client.end());
}

/** Прокси доступен только по Unix-сокету одного скачивания. */
export async function startDownloadProxy(resolveDns?: ResolveDns) {
  const directory = await mkdtemp(path.join(tmpdir(), "studio-egress-"));
  const socketPath = path.join(directory, "proxy.sock");
  const clients = new Set<Socket>();
  const stop = new AbortController();
  let blocked = false;
  const refusal = (error: unknown) => {
    if (error instanceof SafeFetchError && (error.reason === "blocked_address" || error.reason === "bad_url")) {
      blocked = true;
      return 403;
    }
    return 502;
  };
  const server = createServer({ maxHeaderSize: 32 * 1024, headersTimeout: 10_000, requestTimeout: 30_000 }, (req, res) => {
    const lifetime = new AbortController();
    res.once("close", () => lifetime.abort());
    const signal = AbortSignal.any([lifetime.signal, stop.signal]);
    void resolveTarget(req.url ?? "", "http:", resolveDns, signal)
      .then((target) => {
        if (!signal.aborted) forward(req, res, target, signal);
      })
      .catch((error: unknown) => {
        if (!signal.aborted) res.writeHead(refusal(error), { connection: "close" }).end();
      });
  });
  server.on("connect", (req, client, head) => {
    client.pause();
    const lifetime = new AbortController();
    client.once("close", () => lifetime.abort());
    const signal = AbortSignal.any([lifetime.signal, stop.signal]);
    const authority = req.url ?? "";
    // CONNECT использует только форму host:443; HTTP идёт отдельным обработчиком.
    const url = /^(?:\[[0-9a-f:.]+\]|[a-z0-9.-]+):443$/i.test(authority) ? `https://${authority}` : "";
    void resolveTarget(url, "https:", resolveDns, signal)
      .then((target) => {
        if (!signal.aborted) tunnel(client, head, target);
      })
      .catch((error: unknown) => {
        if (signal.aborted) return;
        const status = refusal(error) === 403 ? "403 Forbidden" : "502 Bad Gateway";
        client.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
      });
  });
  server.on("connection", (client) => {
    clients.add(client);
    client.once("close", () => clients.delete(client));
    client.on("error", () => client.destroy());
  });
  try {
    await once(server.listen(socketPath), "listening");
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  return {
    socketPath,
    get blocked() { return blocked; },
    async close() {
      stop.abort();
      for (const client of clients) client.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    },
  };
}
