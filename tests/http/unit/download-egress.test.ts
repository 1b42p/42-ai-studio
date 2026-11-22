import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, vi } from "vitest";

import { startDownloadProxy } from "../../../lib/download/egress";
import { createDownloadIsolation, DOWNLOAD_PROXY } from "../../../lib/download/isolation";
import { childEnv } from "../../../lib/download/process";

test("посредник проверяет адрес фактического HTTP-запроса и HTTPS-туннеля до соединения", async () => {
  const resolved: string[] = [];
  const proxy = await startDownloadProxy(async (hostname) => {
    resolved.push(hostname);
    // Смешанный ответ фиктивного DNS должен быть отклонён целиком.
    return ["93.184.216.34", "192.0.2.1"];
  });
  try {
    async function status(method: string, path: string): Promise<number | undefined> {
      return new Promise((resolve, reject) => {
        const req = request({ socketPath: proxy.socketPath, method, path });
        req.once("error", reject);
        req.once("response", (res) => {
          res.resume();
          resolve(res.statusCode);
        });
        req.once("connect", (res, socket) => {
          socket.destroy();
          resolve(res.statusCode);
        });
        req.end();
      });
    }
    await expect(status("GET", "http://cdn.example.com/fragment.mp4")).resolves.toBe(403);
    expect(proxy.blockedRequests).toBe(1);
    await expect(status("CONNECT", "media.example.com:443")).resolves.toBe(403);
    expect(resolved).toEqual(["cdn.example.com", "media.example.com"]);
    expect(proxy.blockedRequests).toBe(2);
  } finally {
    await proxy.close();
  }
});

test("без bwrap запуск загрузчика недоступен", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "studio-no-bwrap-"));
  vi.stubEnv("PATH", directory);
  try {
    await expect(createDownloadIsolation({ binaries: [process.execPath], runtime: "node" }))
      .rejects.toMatchObject({ code: "download_not_configured" });
  } finally {
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
});

test("дочерний процесс видит только loopback и использует Unix-мост для HTTP-прокси", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "studio-egress-test-"));
  const socketPath = path.join(directory, "proxy.sock");
  const payload = Buffer.alloc(1024 * 1024, 0x42);
  const proxy = createServer((req, res) => {
    res.writeHead(200, { connection: "close", "content-length": payload.length, "x-fixture-url": req.url ?? "" });
    res.end(payload);
  });
  try {
    await once(proxy.listen(socketPath), "listening");
    const run = await createDownloadIsolation({ binaries: [process.execPath], runtime: "node" });
    const result = await run({
      bin: process.execPath,
      args: ["-e", `
        const url = new URL(process.argv[1]);
        const interfaces = Object.values(require("node:os").networkInterfaces()).flat();
        process.stdout.write(JSON.stringify(interfaces.every((item) => item.internal)) + "\\n");
        require("node:http").get({
          hostname: url.hostname,
          port: url.port,
          path: "http://cdn.example.com/video.mp4",
        }, async (res) => {
          let bytes = 0;
          for await (const chunk of res) bytes += chunk.length;
          process.stdout.write(res.headers["x-fixture-url"] + "\\n" + bytes);
        });
      `, DOWNLOAD_PROXY],
      cwd: directory,
      env: childEnv(directory),
      signal: AbortSignal.timeout(5_000),
    }, socketPath);
    expect(result).toMatchObject({ exitCode: 0, stdout: "true\nhttp://cdn.example.com/video.mp4\n1048576" });
  } finally {
    proxy.closeAllConnections();
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
