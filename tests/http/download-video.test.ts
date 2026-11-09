/** download_video через запущенное приложение и фиктивную песочницу. */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { eq } from "drizzle-orm";
import type { MessageStreamEvent } from "eve/client";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import downloadVideo from "../../agent/tools/download_video";
import { loadConfig } from "../../lib/config";
import { appSessions, media, sandboxes, toolCallMedia } from "../../lib/db/schema";
import { formatDownloadModelOutput } from "../../lib/download/policy";
import { resetDownloadQueue, runDownload, type DownloadConfig, type DownloadContext } from "../../lib/download/run";
import { getFakeBackend } from "../../lib/sandbox/fake";
import { appOutput } from "./support/app";
import { createSessionAs, sendAndWait } from "./support/chat";
import { createDaytonaKey, createUser, db } from "./support/db";
import { prepareDownloadFixtures, readStubLog, resetStubLog, STUB_DATA, STUB_PATH } from "./support/download-fixtures";
import { fakeSandbox } from "./support/fake-sandbox";
import { mediaRedirect, readSigned } from "./support/media";
import { s3 } from "./support/s3";
import { fakeMachineFor, sandboxSessionFrom } from "./support/sandbox-session";

const exec = promisify(execFile);
const DF = "Filesystem 1024-blocks Used Available Capacity Mounted on\noverlay 8000000 1000000 7000000 13% /workspace\n";
const DF_SMALL = "Filesystem 1024-blocks Used Available Capacity Mounted on\noverlay 2000 1000 100 50% /workspace\n";
const OK = "https://93.184.216.34/ok";

function toolCommand(input: Record<string, unknown>): string {
  return `/tool download_video ${JSON.stringify(input)}`;
}

function toolResult(events: readonly MessageStreamEvent[]) {
  const results = events.filter((event) => event.type === "action.result");
  const event = results.find((item) =>
    item.data.result.kind === "tool-result" && item.data.result.toolName === "download_video"
  );
  expect(event, "нет результата download_video").toBeDefined();
  return event!.data;
}

function completedOutput(events: readonly MessageStreamEvent[]): Record<string, unknown> {
  const result = toolResult(events);
  expect(result.status).toBe("completed");
  return result.result.kind === "tool-result" ? result.result.output as Record<string, unknown> : {};
}

function failureMessage(events: readonly MessageStreamEvent[]): string {
  const result = toolResult(events);
  expect(result.status).toBe("failed");
  return result.error?.message ?? "";
}

function downloadConfig(overrides: Partial<DownloadConfig> = {}): DownloadConfig {
  const config = loadConfig();
  return {
    ytdlpPath: config.ytdlpPath,
    ffmpegPath: config.ffmpegPath,
    ffprobePath: config.ffprobePath,
    ytdlpJsRuntime: config.ytdlpJsRuntime,
    youtubeCookies: config.youtubeCookies,
    downloadMaxBytes: config.downloadMaxBytes,
    downloadTimeoutMs: config.downloadTimeoutMs,
    ...overrides,
  };
}

async function boundContext(appSessionId: string, eveSessionId: string, callId: string): Promise<DownloadContext> {
  const machine = await fakeMachineFor(appSessionId);
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

async function jpegWidth(bytes: Uint8Array): Promise<number> {
  const directory = await mkdtemp(path.join(tmpdir(), "frame-"));
  const file = path.join(directory, "frame.jpg");
  await writeFile(file, bytes);
  try {
    const { stdout } = await exec("ffprobe", [
      "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width", "-of", "csv=p=0", file,
    ]);
    return Number(stdout.trim());
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

beforeAll(async () => {
  await prepareDownloadFixtures();
}, 60_000);

beforeEach(async () => {
  resetDownloadQueue();
  await fakeSandbox.reset();
  await createDaytonaKey();
  await fakeSandbox.rules.set([{ match: /^df -Pk \/workspace$/, stdout: DF, exitCode: 0 }]);
  await resetStubLog();
});

afterAll(() => {
  expect(appOutput()).not.toContain("FAKE-COOKIE-VALUE");
});

describe("download_video", () => {
  test("кладёт видео в песочницу, кадры в S3 и не повторяет строки того же вызова", async () => {
    const user = await createUser();
    const other = await createUser();
    const { id } = await createSessionAs(user);
    const events = await sendAndWait(user, id, toolCommand({ url: OK, moments: [0.5, 2, 99] }));
    const output = completedOutput(events);
    expect(output.videoPath).toMatch(/^\/workspace\/downloads\/[0-9a-f]{12}\/video\.mp4$/);
    const frames = output.frames as { path: string; momentSec: number; mediaId: string }[];
    expect(frames.map((frame) => frame.path.split("/").at(-1))).toEqual(["frame-0000.50.jpg", "frame-0002.00.jpg"]);
    expect(output.skippedMoments).toEqual([{ momentSec: 99, reason: "after_end" }]);
    expect(JSON.stringify(events)).not.toContain("FAKE-COOKIE-VALUE");

    const video = await fakeSandbox.files.read(id, String(output.videoPath));
    expect(Buffer.from(video!)).toEqual(await readFile(path.join(STUB_DATA, "sample.mp4")));

    for (const frame of frames) {
      const bytes = await fakeSandbox.files.read(id, frame.path);
      expect(bytes).not.toBeNull();
      expect(bytes![0]).toBe(0xff);
      expect(bytes![1]).toBe(0xd8);
      expect(await jpegWidth(bytes!)).toBeLessThanOrEqual(1280);
    }

    const prefix = `u/${user.id}/s/${id}/`;
    const keys = await s3().listKeys(prefix);
    expect(keys.filter((key) => key.includes("/tool-media/"))).toHaveLength(2);
    expect(keys.some((key) => key.endsWith(".mp4"))).toBe(false);

    const mediaRows = await db().select().from(media).where(eq(media.appSessionId, id));
    expect(mediaRows).toHaveLength(2);
    expect(mediaRows.every((row) => row.kind === "tool_media")).toBe(true);
    const links = await db().select().from(toolCallMedia).where(eq(toolCallMedia.appSessionId, id));
    expect(links).toHaveLength(2);
    const result = toolResult(events);
    const callId = result.result.kind === "tool-result" ? result.result.callId : "";
    expect(links.every((link) => link.callId === callId)).toBe(true);

    const redirect = await mediaRedirect(user, frames[0]!.mediaId);
    expect(redirect.status).toBe(302);
    const stored = await fakeSandbox.files.read(id, frames[0]!.path);
    expect(Buffer.from(await readSigned(redirect.location!))).toEqual(Buffer.from(stored!));
    expect((await mediaRedirect(other, frames[0]!.mediaId)).status).toBe(404);

    const [session] = await db().select().from(appSessions).where(eq(appSessions.id, id));
    const [box] = await db().select().from(sandboxes).where(eq(sandboxes.appSessionId, id));
    const machine = await getFakeBackend(loadConfig().fakeSandboxDir!, "dtn_test_secret_value", {
      cpu: 0, memoryGb: 0, diskGb: 0,
    }).get(box!.daytonaSandboxId);
    const connection = machine.connect({ onActivity: async () => {}, onStop: async () => {} });
    const sandbox = Object.assign(sandboxSessionFrom(machine), {
      writeFiles: (options: { files: { path: string; content: Uint8Array }[]; abortSignal?: AbortSignal }) =>
        connection.writeFiles(options),
    });
    await runDownload({ url: OK, moments: [0.5, 2, 99] }, {
      session: { id: session!.eveSessionId! },
      callId,
      abortSignal: new AbortController().signal,
      getSandbox: async () => sandbox,
    }, { config: downloadConfig() });
    expect(await db().select().from(toolCallMedia).where(eq(toolCallMedia.appSessionId, id))).toHaveLength(2);
    expect(await db().select().from(media).where(eq(media.appSessionId, id))).toHaveLength(2);

    await fakeSandbox.stop(id);
    const stopped = await fakeSandbox.counters();
    expect((await mediaRedirect(user, frames[0]!.mediaId)).status).toBe(302);
    expect(await fakeSandbox.counters()).toMatchObject({ started: stopped.started });
  }, 60_000);

  test("без moments берёт один кадр", async () => {
    const user = await createUser();
    const { id } = await createSessionAs(user);
    const output = completedOutput(await sendAndWait(user, id, toolCommand({ url: OK })));
    const frames = output.frames as unknown[];
    expect(frames).toHaveLength(1);
  });

  test("ошибки сайта, размер, пустой файл и нехватка места не оставляют видео", async () => {
    const user = await createUser();
    const { id } = await createSessionAs(user);
    const cases: [string, RegExp][] = [
      ["/playlist", /download_playlist/],
      ["/live", /download_live/],
      ["/private", /download_unavailable/],
      ["/unavailable", /download_unavailable/],
      ["/geo", /download_geo_blocked/],
      ["/login", /download_login_required/],
      ["/big", /download_too_large/],
      ["/nofile", /download_failed/],
    ];
    for (const [pathname, pattern] of cases) {
      const message = failureMessage(await sendAndWait(user, id, toolCommand({ url: `https://93.184.216.34${pathname}` })));
      expect(message, pathname).toMatch(pattern);
    }
    const login = failureMessage(await sendAndWait(user, id, toolCommand({ url: "https://93.184.216.34/login" })));
    expect(login).toContain("Видео требует входа в аккаунт.");
    expect(login).not.toContain("оператору");
    const big = failureMessage(await sendAndWait(user, id, toolCommand({ url: "https://93.184.216.34/big" })));
    expect(big).toContain("9");
    expect(big).toContain("5");

    await resetStubLog();
    const nosize = failureMessage(await sendAndWait(user, id, toolCommand({ url: "https://93.184.216.34/nosize" })));
    expect(nosize).toContain("download_too_large");
    const nosizeLog = await readStubLog();
    expect(nosizeLog.length).toBeGreaterThan(0);
    await expect(access(nosizeLog.at(-1)!.cwd)).rejects.toThrow();
    await expect(exec("pgrep", ["-f", "ytdlp-stub.mjs"])).rejects.toThrow();
    expect((await fakeSandbox.files.list(id, "/workspace")).some((file) => file.endsWith(".mp4"))).toBe(false);

    await fakeSandbox.rules.set([{ match: /^df -Pk \/workspace$/, stdout: DF_SMALL, exitCode: 0 }]);
    const space = failureMessage(await sendAndWait(user, id, toolCommand({ url: OK })));
    expect(space).toContain("download_no_space");
    const listed = await fakeSandbox.files.list(id, "/workspace/downloads");
    expect(listed.some((file) => file.endsWith(".mp4"))).toBe(false);
  }, 60_000);

  test("опасный адрес не запускает yt-dlp", async () => {
    const user = await createUser();
    const { id } = await createSessionAs(user);
    for (const url of [
      "ytsearch1:cats",
      "file:///etc/passwd",
      "https://user:pw@93.184.216.34/ok",
      "http://127.0.0.1/ok",
      "http://169.254.169.254/",
    ]) {
      await resetStubLog();
      const message = failureMessage(await sendAndWait(user, id, toolCommand({ url })));
      expect(message, url).toMatch(/download_bad_url|download_blocked_address/);
      expect(await readStubLog()).toEqual([]);
    }
  }, 60_000);

  test("HEVC назван в тексте для модели", async () => {
    const user = await createUser();
    const { id } = await createSessionAs(user);
    const output = completedOutput(await sendAndWait(user, id, toolCommand({ url: "https://93.184.216.34/hevc", moments: [0.2] })));
    expect(output.videoCodec).toBe("hevc");
    const model = await Promise.resolve(downloadVideo.toModelOutput?.(output as never));
    const text = model && typeof model === "object" && "value" in model ? String(model.value) : "";
    expect(text).toContain("HEVC");
    expect(text).toContain("OffthreadVideo");
    expect(text).toContain("libx264");
    const frames = output.frames as { mediaId: string | null }[];
    for (const frame of frames) {
      if (frame.mediaId !== null) expect(text).not.toContain(frame.mediaId);
    }
  });

  test("остановленная песочница просыпается и получает файл", async () => {
    const user = await createUser();
    const { id } = await createSessionAs(user);
    await sendAndWait(user, id, toolCommand({ url: OK, moments: [0.5] }));
    await fakeSandbox.stop(id);
    const stopped = await fakeSandbox.counters();
    const output = completedOutput(await sendAndWait(user, id, toolCommand({ url: OK, moments: [0.5] })));
    expect((await fakeSandbox.counters()).started).toBe(stopped.started + 1);
    expect(await fakeSandbox.files.read(id, String(output.videoPath))).not.toBeNull();
  }, 60_000);

  test("короткий срок и отсутствующий yt-dlp сообщают свою причину", async () => {
    const user = await createUser();
    const eveSessionId = randomUUID();
    const [session] = await db().insert(appSessions).values({ userId: user.id, eveSessionId }).returning();
    await fakeSandbox.rules.set([{ match: /^df -Pk \/workspace$/, stdout: DF, exitCode: 0 }]);
    const slow = await boundContext(session.id, eveSessionId, "call_slow");
    await expect(runDownload({ url: "https://www.youtube.com/slow" }, slow, {
      config: downloadConfig({ downloadTimeoutMs: 1_500 }),
      resolveDns: async () => ["93.184.216.34"],
    })).rejects.toThrow(/download_timeout/);
    const log = await readStubLog();
    expect(log.length).toBeGreaterThan(0);
    await expect(access(log[0]!.cwd)).rejects.toThrow();
    await expect(exec("pgrep", ["-f", "ytdlp-stub.mjs"])).rejects.toThrow();

    await resetStubLog();
    const missing = await boundContext(session.id, eveSessionId, "call_missing");
    await expect(runDownload({ url: OK }, missing, {
      config: downloadConfig({ ytdlpPath: "/tmp/no-such-ytdlp" }),
    })).rejects.toThrow(/download_not_configured/);
    expect(await readStubLog()).toEqual([]);
  }, 20_000);
});
