/**
 * Скачивание одного видео на сервере приложения: yt-dlp и ffmpeg живут здесь,
 * в песочницу попадает уже готовый файл и кадры.
 */
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { SandboxSession } from "eve/sandbox";

import { publishToolMedia } from "@/lib/media/publish-tool-media";
import { StudioSandboxError } from "@/lib/sandbox/errors";
import { findAppSessionByEveId } from "@/lib/sessions/service";
import { checkOutboundAddress, SafeFetchError, type OutboundPolicy } from "@/lib/web/safe-fetch";

import { downloadError, DownloadToolError } from "./messages";
import {
  classifyYtDlpError,
  cleanSiteReason,
  defaultMoments,
  errorDetail,
  formatSelector,
  frameFileName,
  frameSeek,
  isLiveVideo,
  isYoutubeHost,
  knownDownloadBytes,
  lastErrorLine,
  maxFilesizeLine,
  parseDfAvailableBytes,
  parseFrameRate,
  sanitizeSiteText,
  videoDuration,
  youtubeDelay,
} from "./policy";
import { childEnv, ProcessLimitError, resolveExecutable, runCaptured } from "./process";

const DOWNLOAD_POLICY: OutboundPolicy = {
  schemes: ["http:", "https:"],
  ports: "web",
  maxRedirects: 0,
  timeoutMs: 10_000,
  maxBytes: 1,
};

const RESERVE_BYTES = 512 * 1024 * 1024;
const SLOT_WAIT_MS = 5 * 60 * 1000;
const SLOTS = 2;
const YOUTUBE_GAP_MS = 5_000;
const FRAME_TIMEOUT_MS = 30_000;
const ALLOWED_EXT = new Set(["mp4", "mkv", "webm", "mov"]);

export interface DownloadConfig {
  readonly ytdlpPath: string;
  readonly ffmpegPath?: string;
  readonly ffprobePath: string;
  readonly ytdlpJsRuntime: string;
  readonly youtubeCookies?: string;
  readonly downloadMaxBytes: number;
  readonly downloadTimeoutMs: number;
}

export interface DownloadFrame {
  readonly path: string;
  readonly momentSec: number;
  readonly mediaId: string | null;
}

export interface SkippedMoment {
  readonly momentSec: number;
  readonly reason: "after_end" | "failed";
}

export interface DownloadResult {
  readonly videoPath: string;
  readonly title: string;
  readonly uploader: string;
  readonly site: string;
  readonly sourceUrl: string;
  readonly durationSec: number;
  readonly width: number;
  readonly height: number;
  readonly videoCodec: string;
  readonly sizeBytes: number;
  readonly frames: readonly DownloadFrame[];
  readonly skippedMoments: readonly SkippedMoment[];
}

export type DownloadPhase = "Читаю сведения" | "Скачиваю" | "Достаю кадры" | "Кладу в песочницу";

export interface DownloadContext {
  readonly session: { readonly id: string; readonly parent?: { readonly rootSessionId: string } };
  readonly callId: string;
  readonly abortSignal: AbortSignal;
  getSandbox(): Promise<SandboxSession>;
}

export interface DownloadRunOptions {
  readonly config: DownloadConfig;
  readonly resolveDns?: (hostname: string) => Promise<readonly string[]>;
  readonly onPhase?: (phase: DownloadPhase) => void;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

let active = 0;
const waiters: Array<() => void> = [];
let lastYoutubeStart: number | null = null;

/** Сбрасывает очередь процесса. Нужна тестам, чтобы пауза YouTube не переходила между ними. */
export function resetDownloadQueue(): void {
  active = 0;
  waiters.splice(0);
  lastYoutubeStart = null;
}

function abortReason(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  return Object.assign(new Error("Aborted"), { name: "AbortError" });
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

async function withDownloadSlot<T>(signal: AbortSignal, run: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + SLOT_WAIT_MS;
  while (active >= SLOTS) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw downloadError("download_busy");
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (action: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        const index = waiters.indexOf(wake);
        if (index >= 0) waiters.splice(index, 1);
        action();
      };
      const wake = () => finish(resolve);
      const onAbort = () => finish(() => reject(abortReason(signal)));
      const timer = setTimeout(() => finish(() => reject(downloadError("download_busy"))), remaining);
      waiters.push(wake);
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    });
  }
  active += 1;
  try {
    return await run();
  } finally {
    active -= 1;
    waiters.shift()?.();
  }
}

function scrub(value: string, secret: string | undefined): string {
  if (secret === undefined || secret.length === 0) return value;
  let cleaned = value.split(secret).join("");
  for (const piece of secret.split(/[\t\n\r]/)) {
    const token = piece.trim();
    if (token.length >= 8 && !token.startsWith("#")) cleaned = cleaned.split(token).join("");
  }
  return cleaned;
}

function logDownload(secret: string | undefined, fields: Record<string, string | number | undefined>): void {
  const line: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    line[key] = typeof value === "string" ? scrub(value, secret) : value;
  }
  console.info("[download]", line);
}

async function checkedUrl(input: string, signal: AbortSignal, resolveDns?: DownloadRunOptions["resolveDns"]): Promise<URL> {
  if (input.length > 2000) throw downloadError("download_bad_url");
  try {
    return await checkOutboundAddress(input, { ...DOWNLOAD_POLICY, resolveDns }, signal);
  } catch (error) {
    if (isAbort(error)) throw error;
    if (error instanceof SafeFetchError) {
      if (error.reason === "bad_url") throw downloadError("download_bad_url");
      if (error.reason === "blocked_address") {
        let host = "";
        try {
          host = new URL(input).hostname;
        } catch {
          host = "";
        }
        throw downloadError("download_blocked_address", { host });
      }
      throw downloadError("download_network");
    }
    throw error;
  }
}

async function executable(command: string | undefined, fallback: string | undefined): Promise<string | null> {
  const name = command ?? fallback;
  if (name === undefined) return null;
  return resolveExecutable(name);
}

async function sweepStale(root: string): Promise<void> {
  const entries = await readdir(root).catch(() => [] as string[]);
  const cutoff = Date.now() - 60 * 60 * 1000;
  await Promise.all(entries.map(async (name) => {
    if (!name.startsWith("studio-download-")) return;
    const full = path.join(root, name);
    const info = await stat(full).catch(() => null);
    if (info !== null && info.mtimeMs < cutoff) await rm(full, { recursive: true, force: true });
  }));
}

function commonArgs(config: DownloadConfig, ffmpeg: string | null, cookies: string | null): string[] {
  const args = [
    "--ignore-config",
    "--no-update",
    "--no-cache-dir",
    "--no-warnings",
    "--no-colors",
    "--use-extractors",
    "default,-generic",
    "--no-js-runtimes",
    "--js-runtimes",
    config.ytdlpJsRuntime,
    "--no-playlist",
    "--socket-timeout",
    "20",
    "--retries",
    "3",
    "--fragment-retries",
    "3",
  ];
  if (ffmpeg !== null) args.push("--ffmpeg-location", ffmpeg);
  if (cookies !== null) args.push("--cookies", cookies);
  return args;
}

function failureFromOutput(
  stdout: string,
  stderr: string,
  config: DownloadConfig,
  youtube: boolean,
): DownloadToolError {
  const over = maxFilesizeLine(stdout);
  if (over !== null) {
    return downloadError("download_too_large", {
      actualBytes: over.actual,
      limitBytes: config.downloadMaxBytes,
    });
  }
  const code = classifyYtDlpError(stderr);
  if (code === "download_login_required") {
    return downloadError(code, { youtube, hasCookies: config.youtubeCookies !== undefined });
  }
  if (code === "download_failed") {
    return downloadError(code, { reason: cleanSiteReason(errorDetail(lastErrorLine(stderr))) });
  }
  return downloadError(code);
}

function mapLimit(error: ProcessLimitError, config: DownloadConfig): DownloadToolError {
  if (error.limit === "timeout") return downloadError("download_timeout", { timeoutMs: config.downloadTimeoutMs });
  return downloadError("download_too_large", {
    actualBytes: error.bytes ?? config.downloadMaxBytes,
    limitBytes: config.downloadMaxBytes,
  });
}

async function runLimited<T>(
  signal: AbortSignal,
  timeoutMs: number,
  config: DownloadConfig,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new ProcessLimitError("timeout")), timeoutMs);
  const limited = AbortSignal.any([signal, controller.signal]);
  try {
    return await run(limited);
  } catch (error) {
    if (error instanceof ProcessLimitError) throw mapLimit(error, config);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function probeFormat(ext: string): string {
  if (ext === "mp4" || ext === "mov") return "mov,mp4,m4a,3gp,3g2,mj2";
  return "matroska,webm";
}

async function readProbe(
  ffprobe: string,
  file: string,
  ext: string,
  signal: AbortSignal,
): Promise<{ durationSec: number; width: number; height: number; videoCodec: string; fps: number }> {
  const result = await runCaptured({
    bin: ffprobe,
    args: ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", "-protocol_whitelist", "file", "-f", probeFormat(ext), file],
    cwd: path.dirname(file),
    env: childEnv(path.dirname(file)),
    signal,
  });
  if (result.exitCode !== 0) throw downloadError("download_bad_media");
  let parsed: { streams?: unknown; format?: unknown };
  try {
    parsed = JSON.parse(result.stdout) as { streams?: unknown; format?: unknown };
  } catch {
    throw downloadError("download_bad_media");
  }
  const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
  const video = streams.find((stream) => {
    return typeof stream === "object" && stream !== null && (stream as { codec_type?: unknown }).codec_type === "video";
  }) as Record<string, unknown> | undefined;
  if (video === undefined) throw downloadError("download_bad_media");
  const format = typeof parsed.format === "object" && parsed.format !== null
    ? parsed.format as Record<string, unknown>
    : null;
  const durationSec = videoDuration(video, format);
  const width = typeof video.width === "number" ? video.width : 0;
  const height = typeof video.height === "number" ? video.height : 0;
  const videoCodec = typeof video.codec_name === "string" ? video.codec_name : "";
  if (durationSec === null || width <= 0 || height <= 0 || videoCodec.length === 0) {
    throw downloadError("download_bad_media");
  }
  const fps = parseFrameRate(video.r_frame_rate) || parseFrameRate(video.avg_frame_rate) || 0;
  return { durationSec, width, height, videoCodec, fps };
}

export async function runDownload(
  input: { readonly url: string; readonly moments?: readonly number[]; readonly maxHeight?: number },
  ctx: DownloadContext,
  options: DownloadRunOptions,
): Promise<DownloadResult> {
  const { config } = options;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const report = (phase: DownloadPhase) => options.onPhase?.(phase);
  const started = performance.now();
  let phase: DownloadPhase = "Читаю сведения";
  let host = "";
  const secret = config.youtubeCookies;

  try {
    const runtimeName = config.ytdlpJsRuntime.split(":", 1)[0];
    if (runtimeName !== "node" && runtimeName !== "deno" && runtimeName !== "quickjs") {
      throw downloadError("download_not_configured");
    }
    const ytdlp = await executable(config.ytdlpPath, undefined);
    const ffprobe = await executable(config.ffprobePath, "ffprobe");
    const ffmpeg = config.ffmpegPath === undefined ? null : await executable(config.ffmpegPath, undefined);
    if (ytdlp === null || ffprobe === null || (config.ffmpegPath !== undefined && ffmpeg === null)) {
      throw downloadError("download_not_configured");
    }
    const ffmpegBin = ffmpeg ?? await executable(undefined, "ffmpeg");
    if (ffmpegBin === null) throw downloadError("download_not_configured");

    const url = await checkedUrl(input.url, ctx.abortSignal, options.resolveDns);
    host = url.hostname;
    const youtube = isYoutubeHost(url.hostname);
    const eveId = ctx.session.parent?.rootSessionId ?? ctx.session.id;
    const session = await findAppSessionByEveId(eveId);
    if (session === null) throw downloadError("download_no_session");

    await sweepStale(tmpdir());
    return await withDownloadSlot(ctx.abortSignal, async () => {
      const workDir = await mkdtemp(path.join(tmpdir(), "studio-download-"));
      let cookiesPath: string | null = null;
      try {
        if (youtube) {
          const delay = youtubeDelay(lastYoutubeStart, now(), YOUTUBE_GAP_MS);
          if (delay > 0) await sleep(delay);
          lastYoutubeStart = now();
          if (config.youtubeCookies !== undefined) {
            cookiesPath = path.join(workDir, "cookies.txt");
            await writeFile(cookiesPath, config.youtubeCookies, { mode: 0o600 });
            await chmod(cookiesPath, 0o600);
          }
        }
        const args = commonArgs(config, ffmpeg, cookiesPath);
        const env = childEnv(workDir);
        phase = "Читаю сведения";
        report(phase);

        const info = await runLimited(ctx.abortSignal, config.downloadTimeoutMs, config, async (signal) => {
          const metadata = await runCaptured({
            bin: ytdlp,
            args: [...args, "-J", "--skip-download", "--", url.href],
            cwd: workDir,
            env,
            signal,
          });
          if (metadata.exitCode !== 0) throw failureFromOutput(metadata.stdout, metadata.stderr, config, youtube);
          let parsed: unknown;
          try {
            parsed = JSON.parse(metadata.stdout);
          } catch {
            throw failureFromOutput(metadata.stdout, metadata.stderr, config, youtube);
          }
          if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
            throw downloadError("download_failed", { reason: "сайт не вернул сведения о видео" });
          }
          const record = parsed as Record<string, unknown>;
          if (record._type === "playlist") throw downloadError("download_playlist");
          if (isLiveVideo(record)) throw downloadError("download_live");
          phase = "Скачиваю";
          report(phase);
          const sandbox = await raceAbort(ctx.getSandbox(), signal);
          const needed = (knownDownloadBytes(record) ?? config.downloadMaxBytes) + RESERVE_BYTES;
          const space = await sandbox.run({ command: "df -Pk /workspace", abortSignal: signal });
          if (space.exitCode !== 0) {
            throw downloadError("download_failed", { reason: "не удалось узнать свободное место" });
          }
          const free = parseDfAvailableBytes(space.stdout);
          if (free === null) throw downloadError("download_failed", { reason: "не удалось узнать свободное место" });
          if (free < needed) throw downloadError("download_no_space", { neededBytes: needed, freeBytes: free });
          const infoPath = path.join(workDir, "info.json");
          await writeFile(infoPath, JSON.stringify(record));
          const downloaded = await runCaptured({
            bin: ytdlp,
            args: [
              ...args,
              "--load-info-json",
              infoPath,
              "-f",
              formatSelector(input.maxHeight ?? 720),
              "--merge-output-format",
              "mp4/mkv/webm",
              "--restrict-filenames",
              "--no-part",
              "--no-mtime",
              "--no-progress",
              "--max-filesize",
              String(config.downloadMaxBytes),
              "-o",
              "video.%(ext)s",
              "--print",
              "after_move:filepath",
              "--no-quiet",
              "--",
              url.href,
            ],
            cwd: workDir,
            env,
            signal,
            maxDirBytes: config.downloadMaxBytes,
          });
          if (downloaded.exitCode !== 0) {
            throw failureFromOutput(downloaded.stdout, downloaded.stderr, config, youtube);
          }
          const over = maxFilesizeLine(downloaded.stdout);
          if (over !== null) {
            throw downloadError("download_too_large", {
              actualBytes: over.actual,
              limitBytes: config.downloadMaxBytes,
            });
          }
          const printed = downloaded.stdout.split("\n").map((line) => line.trim()).filter(Boolean).at(-1);
          if (printed === undefined) throw downloadError("download_failed", { reason: "yt-dlp завершился без файла" });
          return { record, printed };
        });

        const candidate = path.isAbsolute(info.printed) ? info.printed : path.join(workDir, info.printed);
        const real = await realpath(candidate).catch(() => null);
        if (real === null) throw downloadError("download_failed", { reason: "yt-dlp завершился без файла" });
        const relative = path.relative(workDir, real);
        if (relative.startsWith("..") || path.isAbsolute(relative)) {
          throw downloadError("download_failed", { reason: "yt-dlp записал файл вне рабочего каталога" });
        }
        const ext = path.extname(real).slice(1).toLowerCase();
        if (!ALLOWED_EXT.has(ext)) throw downloadError("download_bad_media");
        const fileInfo = await stat(real);
        if (fileInfo.size > config.downloadMaxBytes) {
          throw downloadError("download_too_large", {
            actualBytes: fileInfo.size,
            limitBytes: config.downloadMaxBytes,
          });
        }

        phase = "Достаю кадры";
        report(phase);
        const probed = await readProbe(
          ffprobe,
          real,
          ext,
          AbortSignal.any([ctx.abortSignal, AbortSignal.timeout(FRAME_TIMEOUT_MS)]),
        ).catch((error: unknown) => {
          if (isAbort(error)) throw error;
          throw downloadError("download_bad_media");
        });
        const moments = input.moments !== undefined && input.moments.length > 0
          ? input.moments
          : defaultMoments(probed.durationSec);
        const extracted: { momentSec: number; name: string; bytes: Uint8Array }[] = [];
        const skipped: SkippedMoment[] = [];
        for (const momentSec of moments) {
          const decision = frameSeek(momentSec, probed.durationSec, probed.fps);
          if (!decision.ok) {
            skipped.push({ momentSec, reason: "after_end" });
            continue;
          }
          const name = frameFileName(momentSec);
          const framePath = path.join(workDir, name);
          try {
            const frame = await runCaptured({
              bin: ffmpegBin,
              args: [
                "-y",
                "-ss",
                decision.seconds.toFixed(3),
                "-protocol_whitelist",
                "file",
                "-nostdin",
                "-i",
                real,
                "-frames:v",
                "1",
                "-an",
                "-sn",
                "-vf",
                "scale='min(1280,iw)':-2",
                "-pix_fmt",
                "yuvj420p",
                "-q:v",
                "3",
                framePath,
              ],
              cwd: workDir,
              env: childEnv(workDir),
              signal: AbortSignal.any([ctx.abortSignal, AbortSignal.timeout(FRAME_TIMEOUT_MS)]),
            });
            if (frame.exitCode !== 0) throw downloadError("download_bad_media");
            extracted.push({ momentSec, name, bytes: await readFile(framePath) });
          } catch (error) {
            if (isAbort(error)) throw error;
            skipped.push({ momentSec, reason: "failed" });
          }
        }
        if (extracted.length === 0 && !skipped.some((item) => item.reason === "after_end")) {
          throw downloadError("download_bad_media");
        }

        phase = "Кладу в песочницу";
        report(phase);
        const directory = createHash("sha256").update(ctx.callId).digest("hex").slice(0, 12);
        const sandboxDir = `/workspace/downloads/${directory}`;
        const videoPath = `${sandboxDir}/video.${ext}`;
        const sandbox = await ctx.getSandbox();
        await sandbox.writeFiles({
          files: [
            { path: videoPath, content: await readFile(real) },
            ...extracted.map((frame) => ({
              path: `${sandboxDir}/frames/${frame.name}`,
              content: frame.bytes,
            })),
          ],
          abortSignal: ctx.abortSignal,
        });
        const frames: DownloadFrame[] = [];
        for (const frame of extracted) {
          const framePath = `${sandboxDir}/frames/${frame.name}`;
          let mediaId: string | null = null;
          try {
            const published = await publishToolMedia(ctx, { path: framePath, contentType: "image/jpeg" });
            mediaId = published.mediaId;
          } catch (error) {
            if (isAbort(error)) throw error;
            console.warn("[download] frame_publish_failed", error instanceof Error ? error.name : "error");
          }
          frames.push({ path: framePath, momentSec: frame.momentSec, mediaId });
        }
        const result: DownloadResult = {
          videoPath,
          title: sanitizeSiteText(info.record.title) || "Видео",
          uploader: sanitizeSiteText(info.record.uploader),
          site: sanitizeSiteText(info.record.extractor),
          sourceUrl: url.href,
          durationSec: probed.durationSec,
          width: probed.width,
          height: probed.height,
          videoCodec: probed.videoCodec,
          sizeBytes: fileInfo.size,
          frames,
          skippedMoments: skipped,
        };
        logDownload(secret, {
          host,
          phase,
          durationMs: Math.round(performance.now() - started),
          sizeBytes: fileInfo.size,
          reason: "ok",
        });
        return result;
      } finally {
        if (cookiesPath !== null) await rm(cookiesPath, { force: true }).catch(() => undefined);
        await rm(workDir, { recursive: true, force: true });
      }
    });
  } catch (error) {
    if (isAbort(error) || error instanceof StudioSandboxError) throw error;
    const reason = error instanceof DownloadToolError ? error.code : "download_failed";
    const detail = error instanceof DownloadToolError ? error.message : undefined;
    logDownload(secret, {
      host,
      phase,
      durationMs: Math.round(performance.now() - started),
      reason,
      detail,
    });
    if (error instanceof DownloadToolError) throw error;
    throw downloadError("download_failed", { reason: "неизвестная ошибка" });
  }
}

function raceAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}
