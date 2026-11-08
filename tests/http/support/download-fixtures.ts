/** Образцы видео и журнал замены yt-dlp. */
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export const STUB_PATH = path.resolve("tests/http/fixtures/ytdlp-stub.mjs");
export const STUB_DATA = path.resolve(".tmp/ytdlp-stub");
const LOG = path.join(STUB_DATA, "invocations.ndjson");

async function sample(name: string, args: readonly string[]): Promise<void> {
  const target = path.join(STUB_DATA, name);
  try {
    await access(target);
    return;
  } catch {
    // файла ещё нет
  }
  await exec("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", ...args, target]);
}

/** Короткий ролик H.264, тот же ролик в HEVC и в MKV. Повторно не кодирует. */
export async function prepareDownloadFixtures(): Promise<void> {
  await mkdir(STUB_DATA, { recursive: true });
  const picture = ["-f", "lavfi", "-i", "testsrc=size=320x240:rate=15:duration=3"];
  const tone = ["-f", "lavfi", "-i", "sine=frequency=440:duration=3"];
  await sample("sample.mp4", [
    ...picture,
    ...tone,
    "-c:v", "libx264",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-shortest",
  ]);
  await sample("sample.mkv", [
    ...picture,
    ...tone,
    "-c:v", "libx264",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-shortest",
  ]);
  await sample("sample-hevc.mp4", [
    "-f", "lavfi", "-i", "testsrc=size=320x240:rate=15:duration=1",
    "-c:v", "libx265",
    "-pix_fmt", "yuv420p",
    "-an",
    "-x265-params", "log-level=error",
  ]);
}

export async function resetStubLog(): Promise<void> {
  await mkdir(STUB_DATA, { recursive: true });
  await writeFile(LOG, "");
}

export interface StubInvocation {
  argv: string[];
  env: Record<string, string>;
  cwd: string;
  cookies: { path: string; mode: string; content: string } | null;
}

export async function readStubLog(): Promise<StubInvocation[]> {
  const text = await readFile(LOG, "utf8").catch(() => "");
  return text.split("\n").filter((line) => line.length > 0).map((line) => JSON.parse(line) as StubInvocation);
}
