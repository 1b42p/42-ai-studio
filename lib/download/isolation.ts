import { realpath } from "node:fs/promises";
import path from "node:path";

import { downloadError } from "./messages";
import { resolveExecutable, runCaptured, type ProcessResult } from "./process";

const SOCKET = "/run/studio-download.sock";
const PROXY_PORT = 19840;
const BRIDGE_FAILURE = 126;
const NODE = "/studio-bin/node";
export const DOWNLOAD_PROXY = `http://127.0.0.1:${PROXY_PORT}`;

// Перед запуском загрузчика открывает loopback-порт внутри нового namespace.
// Единственный сетевой мост ведёт к одному Unix-сокету, без выбора адреса.
const RELAY = `
  const { spawn } = require("node:child_process");
  const { createServer, createConnection } = require("node:net");
  const [bin, ...args] = process.argv.slice(1);
  const relay = createServer((client) => {
    const upstream = createConnection(${JSON.stringify(SOCKET)});
    client.on("error", () => upstream.destroy());
    upstream.on("error", () => client.destroy());
    client.on("close", () => upstream.destroy());
    upstream.on("close", () => {
      // При штатном EOF pipe уже поставил FIN после данных: не обрываем очередь записи.
      if (!client.writableEnded) client.destroy();
    });
    client.pipe(upstream).pipe(client);
  });
  relay.on("error", () => process.exit(${BRIDGE_FAILURE}));
  relay.listen(${PROXY_PORT}, "127.0.0.1", () => {
    const { PATH, HOME, TMPDIR, LANG } = process.env;
    const child = spawn(bin, args, { env: { PATH, HOME, TMPDIR, LANG }, stdio: ["ignore", "inherit", "inherit"] });
    child.on("error", () => process.exit(${BRIDGE_FAILURE}));
    child.on("close", (code) => process.exit(code ?? 1));
  });
`;

export async function createDownloadIsolation(options: {
  readonly binaries: readonly string[];
  readonly runtime: string;
  readonly fixtureData?: string;
}) {
  const bwrap = process.platform === "linux" ? await resolveExecutable("bwrap") : null;
  if (!bwrap) throw downloadError("download_not_configured");
  const [runtime, command] = options.runtime.split(":", 2);
  const runtimeBinary = runtime === "quickjs" ? "qjs" : runtime;
  const customRuntime = command ?? (runtime === "node" ? undefined : await resolveExecutable(runtimeBinary));
  const mounts = [
    "--unshare-user", "--disable-userns", "--unshare-net", "--unshare-pid", "--unshare-ipc", "--unshare-uts",
    "--cap-drop", "ALL", "--die-with-parent", "--new-session",
    "--proc", "/proc", "--dev", "/dev",
    "--ro-bind", "/usr", "/usr",
    ...["/lib", "/lib64", "/bin", "/etc/ssl/certs", "/etc/pki/tls/certs"].flatMap((dir) => ["--ro-bind-try", dir, dir]),
    "--ro-bind", await realpath(process.execPath), NODE,
    "--setenv", "PATH", "/studio-bin:/usr/local/bin:/usr/bin:/bin",
  ];
  for (const binary of new Set(options.binaries)) {
    const source = await realpath(binary).catch(() => null);
    if (source !== null && !binary.startsWith("/usr/") && !binary.startsWith("/bin/")) {
      mounts.push("--ro-bind", source, binary);
    }
  }
  if (customRuntime?.startsWith("/")) {
    const source = await realpath(customRuntime).catch(() => null);
    const destination = command === undefined ? `/studio-bin/${runtimeBinary}` : customRuntime;
    if (source !== null && !destination.startsWith("/usr/") && !destination.startsWith("/bin/")) {
      mounts.push("--ro-bind", source, destination);
    }
  }
  if (options.fixtureData !== undefined) {
    mounts.push("--bind-try", options.fixtureData, options.fixtureData);
  }

  return async function run(
    input: Parameters<typeof runCaptured>[0],
    proxySocket?: string,
  ): Promise<ProcessResult> {
    const result = await runCaptured({
      ...input,
      bin: bwrap,
      args: [
        ...mounts,
        "--bind", input.cwd, input.cwd,
        "--chdir", input.cwd,
        ...(proxySocket === undefined
          ? ["--", input.bin, ...input.args]
          : ["--ro-bind", proxySocket, SOCKET, "--", NODE, "-e", RELAY, "--", input.bin, ...input.args]),
      ],
    });
    if (result.exitCode === BRIDGE_FAILURE || (result.exitCode !== 0 && /^bwrap: /m.test(result.stderr))) {
      throw downloadError("download_not_configured");
    }
    return result;
  };
}

/** Только для штатного файла фикстуры; сетевая изоляция остаётся включена. */
export function downloadFixtureData(binary: string, appTestMode: boolean | undefined): string | undefined {
  if (appTestMode && binary.endsWith("/tests/http/fixtures/ytdlp-stub.mjs")) {
    return path.resolve(path.dirname(binary), "../../../.tmp/ytdlp-stub");
  }
}
