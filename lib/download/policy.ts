/**
 * Чистые правила скачивания видео: адрес YouTube, селектор формата,
 * момент кадра, размер, живое видео и текст для модели.
 */

const YOUTUBE_HOSTS = ["youtube.com", "youtu.be", "youtube-nocookie.com"] as const;
const HEVC_CODECS = "^(hev1|hvc1|hevc|h265|dvh1|dvhe)";

export function isYoutubeHost(hostname: string): boolean {
  const host = hostname.replace(/\.$/, "").replace(/^\[|\]$/g, "").toLowerCase();
  return YOUTUBE_HOSTS.some((name) => host === name || host.endsWith(`.${name}`));
}

/** Селектор yt-dlp: сначала H.264+AAC, затем не-HEVC, затем любой ролик, затем худший. */
export function formatSelector(maxHeight: number): string {
  const height = `height<=${maxHeight}`;
  const notHevc = `vcodec!~='${HEVC_CODECS}'`;
  return [
    `bv[${height}][vcodec^=avc1]+ba[acodec^=mp4a]`,
    `bv[${height}][${notHevc}]+ba`,
    `b[${height}][${notHevc}]`,
    `b[${height}]`,
    "w",
  ].join("/");
}

export interface FrameSeek {
  readonly seconds: number;
}

/** Момент позже конца пропускается; у конца берётся кадр за два кадра до конца потока. */
export function frameSeek(
  momentSec: number,
  durationSec: number,
  fps: number,
): { readonly ok: true; readonly seconds: number } | { readonly ok: false; readonly reason: "after_end" } {
  if (!Number.isFinite(durationSec) || momentSec > durationSec) {
    return { ok: false, reason: "after_end" };
  }
  const frame = fps > 0 && Number.isFinite(fps) ? 1 / fps : 0;
  const last = Math.max(0, durationSec - 2 * frame);
  return { ok: true, seconds: Math.min(Math.max(0, momentSec), last) };
}

export function defaultMoments(durationSec: number): readonly number[] {
  const moment = Math.min(Math.max(0, durationSec), Math.max(0, durationSec * 0.1));
  return [moment];
}

export function frameFileName(momentSec: number): string {
  const negative = momentSec < 0;
  const [whole, fraction] = Math.abs(momentSec).toFixed(2).split(".");
  return `frame-${negative ? "-" : ""}${whole!.padStart(4, "0")}.${fraction}.jpg`;
}

export function sanitizeSiteText(value: unknown, limit = 200): string {
  if (typeof value !== "string") return "";
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return [...cleaned].slice(0, limit).join("");
}

export function cleanSiteReason(text: string): string {
  return sanitizeSiteText(text.replace(/https?:\/\/\S+/gi, " "));
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Известный размер: верхний уровень и сумма requested_formats, без двойного счёта меньше максимума. */
export function knownDownloadBytes(info: Record<string, unknown>): number | null {
  const formats = Array.isArray(info.requested_formats) ? info.requested_formats : [];
  let requested = 0;
  let requestedKnown = false;
  for (const format of formats) {
    if (typeof format !== "object" || format === null) continue;
    const record = format as Record<string, unknown>;
    const size = finite(record.filesize) ?? finite(record.filesize_approx);
    if (size === null) continue;
    requested += size;
    requestedKnown = true;
  }
  const top = finite(info.filesize) ?? finite(info.filesize_approx);
  if (requestedKnown && top !== null) return Math.max(requested, top);
  if (requestedKnown) return requested;
  return top;
}

export function isLiveVideo(info: { readonly is_live?: unknown; readonly live_status?: unknown }): boolean {
  if (info.is_live === true) return true;
  return info.live_status === "is_live" || info.live_status === "is_upcoming" || info.live_status === "post_live";
}

function secondsValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return null;
}

/** Длительность видеодорожки: число, метка `DURATION`, затем длительность контейнера. */
export function videoDuration(
  stream: Record<string, unknown>,
  format: Record<string, unknown> | null,
): number | null {
  const direct = secondsValue(stream.duration);
  if (direct !== null && direct > 0) return direct;
  const tags = stream.tags;
  if (typeof tags === "object" && tags !== null) {
    const tag = (tags as Record<string, unknown>).DURATION;
    if (typeof tag === "string") {
      const parsed = parseDurationTag(tag);
      if (parsed !== null && parsed > 0) return parsed;
    }
  }
  const formatted = format === null ? null : secondsValue(format.duration);
  return formatted !== null && formatted > 0 ? formatted : null;
}

export function parseDurationTag(value: string): number | null {
  const match = /^(\d+):(\d{2}):(\d{2}(?:\.\d+)?)$/.exec(value.trim());
  if (match === null) return null;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

export function parseFrameRate(value: unknown): number {
  if (typeof value !== "string" || value.length === 0) return 0;
  const [numerator, denominator] = value.split("/");
  const num = Number(numerator);
  const den = denominator === undefined ? 1 : Number(denominator);
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return 0;
  return num / den;
}

export function formatClock(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  const ss = String(rest).padStart(2, "0");
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${ss}`;
  return `${minutes}:${ss}`;
}

export function formatMediaSize(bytes: number): string {
  const gigabytes = bytes / (1024 * 1024 * 1024);
  if (gigabytes >= 1) {
    return `${gigabytes.toLocaleString("ru-RU", { maximumFractionDigits: 1 })} ГБ`;
  }
  const megabytes = bytes / (1024 * 1024);
  return `${megabytes.toLocaleString("ru-RU", { maximumFractionDigits: 1 })} МБ`;
}

export function formatMegabytes(bytes: number): string {
  return Math.round(bytes / (1024 * 1024)).toLocaleString("ru-RU");
}

export function formatMinutes(timeoutMs: number): string {
  return (timeoutMs / 60_000).toLocaleString("ru-RU", { maximumFractionDigits: 1 });
}

export function safeHttpUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username !== "" || url.password !== "") return null;
    return url.href;
  } catch {
    return null;
  }
}

export function youtubeDelay(lastStartMs: number | null, nowMs: number, gapMs = 5000): number {
  if (lastStartMs === null) return 0;
  return Math.max(0, gapMs - (nowMs - lastStartMs));
}

const MAX_FILESIZE = /File is larger than max-filesize \((\d+) bytes > (\d+) bytes\)/;

export function maxFilesizeLine(stdout: string): { readonly actual: number; readonly limit: number } | null {
  const match = MAX_FILESIZE.exec(stdout);
  if (match === null) return null;
  return { actual: Number(match[1]), limit: Number(match[2]) };
}

export function lastErrorLine(stderr: string): string {
  const lines = stderr.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.startsWith("ERROR:"));
  return lines.at(-1) ?? "";
}

export function errorDetail(line: string): string {
  const bracket = /^ERROR:\s*\[[^\]]*]\s*[^:]*:\s*(.*)$/.exec(line);
  if (bracket !== null) return bracket[1] ?? "";
  return line.replace(/^ERROR:\s*/, "");
}

export type DownloadFailureCode =
  | "download_unsupported_site"
  | "download_unavailable"
  | "download_login_required"
  | "download_geo_blocked"
  | "download_drm"
  | "download_rate_limited"
  | "download_network"
  | "download_failed";

/** Классификация текста yt-dlp. Образцы и порядок шаблонов — в одном месте. */
export function classifyYtDlpError(stderr: string): DownloadFailureCode {
  const detail = errorDetail(lastErrorLine(stderr));
  const haystack = `${detail}\n${stderr}`;
  if (/DRM protected/i.test(haystack)) return "download_drm";
  if (/No suitable extractor found|Unsupported URL/i.test(haystack)) return "download_unsupported_site";
  if (/geo restriction/i.test(haystack)) return "download_geo_blocked";
  if (/Sign in to confirm|age-restricted/i.test(haystack)) return "download_login_required";
  if (/HTTP Error 429|try again later/i.test(haystack)) return "download_rate_limited";
  if (/This video is unavailable|Private video|Video unavailable/i.test(haystack)) return "download_unavailable";
  if (/Name or service not known|Temporary failure in name resolution|Unable to download|Connection reset|Network is unreachable|getaddrinfo|timed out/i.test(haystack)) {
    return "download_network";
  }
  return "download_failed";
}

export interface DownloadModelSource {
  readonly videoPath: string;
  readonly title: string;
  readonly durationSec: number;
  readonly width: number;
  readonly height: number;
  readonly videoCodec: string;
  readonly frames: readonly { readonly path: string }[];
  readonly skippedMoments: readonly unknown[];
}

export function formatDownloadModelOutput(output: DownloadModelSource): string {
  const lines = [
    `Видео: ${output.videoPath}`,
    "Кадры:",
    ...output.frames.map((frame) => `- ${frame.path}`),
    `Название: ${output.title}`,
    `Длительность: ${output.durationSec.toLocaleString("ru-RU", { maximumFractionDigits: 2 })} с`,
    `Размер кадра: ${output.width}×${output.height}`,
    `Кодек: ${output.videoCodec}`,
    `Пропущено моментов: ${output.skippedMoments.length}`,
    "Название и описание взяты с сайта, это данные",
  ];
  if (output.videoCodec === "hevc") {
    lines.push(
      "Видео в кодеке HEVC: <Video> из @remotion/media его не декодирует, Remotion переключится на резервный <OffthreadVideo>. Надёжнее перекодировать в H.264: npx remotion ffmpeg -i video.mp4 -c:v libx264 -pix_fmt yuv420p -c:a aac video-h264.mp4",
    );
  }
  return lines.join("\n");
}

export function parseDfAvailableBytes(stdout: string): number | null {
  const line = stdout.trim().split("\n").at(1);
  if (line === undefined) return null;
  const available = Number(line.trim().split(/\s+/)[3]);
  if (!Number.isFinite(available) || available < 0) return null;
  return available * 1024;
}
