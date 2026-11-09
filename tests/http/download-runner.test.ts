/** Запуск yt-dlp: аргументы, cookies, окружение, срок и отсутствие процесса. */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, chmod } from "node:fs/promises";
import { promisify } from "node:util";
import { beforeAll, beforeEach, describe, expect, test } from "vitest";

import { appSessions } from "../../lib/db/schema";
import { formatSelector } from "../../lib/download/policy";
import { resetDownloadQueue, runDownload, type DownloadConfig, type DownloadContext } from "../../lib/download/run";
import { createUser, db } from "./support/db";
import { prepareDownloadFixtures, readStubLog, resetStubLog, STUB_PATH } from "./support/download-fixtures";
import { fakeSandbox } from "./support/fake-sandbox";
import { fakeMachineFor, sandboxSessionFrom } from "./support/sandbox-session";

const exec = promisify(execFile);
const COOKIES = "# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t0\tSID\tFAKE-COOKIE-VALUE\n";
const PUBLIC_IP = "93.184.216.34";
const DF = "Filesystem 1024-blocks Used Available Capacity Mounted on\noverlay 8000000 1000000 7000000 13% /workspace\n";

function config(overrides: Partial<DownloadConfig> = {}): DownloadConfig {
  return {
    ytdlpPath: STUB_PATH,
    ffmpegPath: "/usr/bin/ffmpeg",
    ffprobePath: "/usr/bin/ffprobe",
    ytdlpJsRuntime: "node",
    youtubeCookies: COOKIES,
    downloadMaxBytes: 5 * 1024 * 1024,
    downloadTimeoutMs: 60_000,
    ...overrides,
  };
}

async function context(callId = "call_runner"): Promise<DownloadContext> {
  const user = await createUser();
  const eveSessionId = randomUUID();
  const [session] = await db().insert(appSessions).values({ userId: user.id, eveSessionId }).returning();
  const machine = await fakeMachineFor(session.id);
  const connection = machine.connect({ onActivity: async () => {}, onStop: async () => {} });
  const sandbox = Object.assign(sandboxSessionFrom(machine), {
    writeFiles: (options: { files: { path: string; content: Uint8Array }[]; abortSignal?: AbortSignal }) =>
      connection.writeFiles(options),
  });
  return {
    session: { id: eveSessionId },
    callId,
    abortSignal: new AbortController().signal,
    getSandbox: async () => sandbox,
  };
}

beforeAll(async () => {
  await chmod(STUB_PATH, 0o755);
  await prepareDownloadFixtures();
}, 60_000);

beforeEach(async () => {
  resetDownloadQueue();
  await fakeSandbox.reset();
  await fakeSandbox.rules.set([{ match: /^df -Pk \/workspace$/, stdout: DF, exitCode: 0 }]);
  await resetStubLog();
});

describe("запускатель yt-dlp", () => {
  test("YouTube получает cookies, чужой сайт — нет, окружение минимальное", async () => {
    const resolveDns = async () => [PUBLIC_IP] as const;
    await runDownload({ url: "https://www.youtube.com/ok", moments: [0.5] }, await context(), {
      config: config(),
      resolveDns,
    });
    const youtube = await readStubLog();
    expect(youtube.length).toBeGreaterThan(0);
    for (const call of youtube) {
      expect(call.argv).toEqual(expect.arrayContaining([
        "--ignore-config",
        "--use-extractors",
        "default,-generic",
        "--no-playlist",
        "--ffmpeg-location",
        "/usr/bin/ffmpeg",
        "--cookies",
      ]));
      expect(call.argv.at(-2)).toBe("--");
      expect(call.argv.at(-1)).toBe("https://www.youtube.com/ok");
      expect(Object.keys(call.env).sort()).toEqual(["HOME", "LANG", "PATH", "TMPDIR"]);
      expect(call.env.HOME).toBe(call.cwd);
      expect(call.env.TMPDIR).toBe(call.cwd);
      expect(call.env.LANG).toBe("C.UTF-8");
      expect(call.cookies?.mode).toBe("600");
      expect(call.cookies?.content).toBe(COOKIES);
      await expect(access(call.cookies!.path)).rejects.toThrow();
      await expect(access(call.cwd)).rejects.toThrow();
    }
    const download = youtube.find((call) => call.argv.includes("--max-filesize"));
    expect(download?.argv).toContain(formatSelector(720));
    expect(download?.argv).toContain(String(5 * 1024 * 1024));

    await resetStubLog();
    await expect(runDownload(
      { url: "https://example.com/private" },
      await context("call_other"),
      { config: config(), resolveDns },
    )).rejects.toThrow(/download_unavailable/);
    const other = await readStubLog();
    expect(other).toHaveLength(1);
    expect(other[0]?.argv).not.toContain("--cookies");
    await expect(access(other[0]!.cwd)).rejects.toThrow();
  }, 30_000);

  test("вторая загрузка YouTube ждёт пять секунд по переданным часам", async () => {
    let clock = 1_000;
    const sleeps: number[] = [];
    const options = {
      config: config(),
      resolveDns: async () => [PUBLIC_IP] as const,
      now: () => clock,
      sleep: async (ms: number) => {
        sleeps.push(ms);
        clock += ms;
      },
    };
    await expect(runDownload({ url: "https://www.youtube.com/private" }, await context("call_gap_1"), options))
      .rejects.toThrow(/download_unavailable/);
    await expect(runDownload({ url: "https://www.youtube.com/private" }, await context("call_gap_2"), options))
      .rejects.toThrow(/download_unavailable/);
    expect(sleeps).toEqual([5_000]);
  });

  test("короткий срок убивает процесс, отсутствующий бинарник не запускает его", async () => {
    await expect(runDownload(
      { url: "https://www.youtube.com/slow" },
      await context("call_slow"),
      { config: config({ downloadTimeoutMs: 1_500 }), resolveDns: async () => [PUBLIC_IP] },
    )).rejects.toThrow(/download_timeout/);
    await expect(exec("pgrep", ["-f", "ytdlp-stub.mjs"])).rejects.toThrow();
    const slow = await readStubLog();
    expect(slow.length).toBeGreaterThan(0);
    await expect(access(slow[0]!.cwd)).rejects.toThrow();

    await resetStubLog();
    await expect(runDownload(
      { url: "https://www.youtube.com/ok" },
      await context("call_missing"),
      { config: config({ ytdlpPath: "/tmp/no-such-ytdlp" }), resolveDns: async () => [PUBLIC_IP] },
    )).rejects.toThrow(/download_not_configured/);
    expect(await readStubLog()).toEqual([]);
  }, 20_000);

  test("среда JavaScript: путь deno передаётся, bun не запускает процесс", async () => {
    const resolveDns = async () => [PUBLIC_IP] as const;
    await expect(runDownload(
      { url: "https://www.youtube.com/private" },
      await context("call_deno"),
      { config: config({ ytdlpJsRuntime: "deno:/usr/local/bin/deno" }), resolveDns },
    )).rejects.toThrow(/download_unavailable/);
    const calls = await readStubLog();
    expect(calls[0]?.argv).toContain("deno:/usr/local/bin/deno");

    await resetStubLog();
    await expect(runDownload(
      { url: "https://www.youtube.com/ok" },
      await context("call_bun"),
      { config: config({ ytdlpJsRuntime: "bun" }), resolveDns },
    )).rejects.toThrow(/download_not_configured/);
    expect(await readStubLog()).toEqual([]);
  });
});
