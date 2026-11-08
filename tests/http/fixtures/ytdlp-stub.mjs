#!/usr/bin/env node
/**
 * Замена yt-dlp для HTTP-тестов. Сценарий берётся из пути URL.
 * Журнал вызовов — `.tmp/ytdlp-stub/invocations.ndjson`, образцы лежат рядом.
 */
import { appendFileSync, copyFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dataDir = join(dirname(fileURLToPath(import.meta.url)), "../../../.tmp/ytdlp-stub");
const args = process.argv.slice(2);
const url = args.at(-1) ?? "";
let cookies = null;
const cookieIndex = args.indexOf("--cookies");
if (cookieIndex >= 0) {
  const file = args[cookieIndex + 1];
  const info = statSync(file);
  cookies = {
    path: file,
    mode: (info.mode & 0o777).toString(8),
    content: readFileSync(file, "utf8"),
  };
}
mkdirSync(dataDir, { recursive: true });
appendFileSync(join(dataDir, "invocations.ndjson"), `${JSON.stringify({
  argv: args,
  env: process.env,
  cwd: process.cwd(),
  cookies,
})}\n`);

const pathname = (() => {
  try {
    return new URL(url).pathname;
  } catch {
    return "";
  }
})();

const metadata = args.includes("-J") || args.includes("--skip-download");

function fail(line) {
  process.stdout.write("null\n");
  process.stderr.write(`${line}\n`);
  process.exit(1);
}

function info(extra = {}) {
  return {
    id: "ok",
    title: "Me at the zoo",
    uploader: "jawed",
    extractor: "Youtube",
    duration: 3,
    is_live: false,
    filesize: 200_000,
    ext: "mp4",
    ...extra,
  };
}

function copySample(name, ext) {
  const dest = join(process.cwd(), `video.${ext}`);
  copyFileSync(join(dataDir, name), dest);
  process.stdout.write(`${dest}\n`);
}

const errors = {
  "/private": "ERROR: Private video",
  "/unavailable": "ERROR: Video unavailable",
  "/geo": "ERROR: This video is not available due to geo restriction",
  "/login": "ERROR: Sign in to confirm you're not a bot",
};

if (pathname in errors) fail(errors[pathname]);

if (pathname === "/playlist") {
  process.stdout.write(`${JSON.stringify({ _type: "playlist", title: "list" })}\n`);
  process.exit(0);
}

if (pathname === "/live") {
  process.stdout.write(`${JSON.stringify(info({ is_live: true, live_status: "is_live" }))}\n`);
  process.exit(0);
}

if (pathname === "/slow") {
  await new Promise((resolve) => setTimeout(resolve, 120_000));
  process.exit(0);
}

if (pathname === "/big") {
  if (metadata) {
    process.stdout.write(`${JSON.stringify(info({ filesize: 9_000_000 }))}\n`);
    process.exit(0);
  }
  process.stdout.write("File is larger than max-filesize (9000000 bytes > 5242880 bytes)\n");
  process.exit(0);
}

if (pathname === "/nosize") {
  if (metadata) {
    const { filesize: _filesize, ...rest } = info();
    process.stdout.write(`${JSON.stringify(rest)}\n`);
    process.exit(0);
  }
  writeFileSync(join(process.cwd(), "video.mp4"), Buffer.alloc(8 * 1024 * 1024));
  await new Promise((resolve) => setTimeout(resolve, 120_000));
  process.exit(0);
}

if (pathname === "/nofile") {
  if (metadata) {
    process.stdout.write(`${JSON.stringify(info())}\n`);
    process.exit(0);
  }
  process.stdout.write(`${join(process.cwd(), "missing.mp4")}\n`);
  process.exit(0);
}

if (pathname === "/hevc") {
  if (metadata) {
    process.stdout.write(`${JSON.stringify(info())}\n`);
    process.exit(0);
  }
  copySample("sample-hevc.mp4", "mp4");
  process.exit(0);
}

if (pathname === "/mkv") {
  if (metadata) {
    process.stdout.write(`${JSON.stringify(info({ ext: "mkv" }))}\n`);
    process.exit(0);
  }
  copySample("sample.mkv", "mkv");
  process.exit(0);
}

if (pathname === "/ok") {
  if (metadata) {
    process.stdout.write(`${JSON.stringify(info())}\n`);
    process.exit(0);
  }
  copySample("sample.mp4", "mp4");
  process.exit(0);
}

fail("ERROR: No suitable extractor found");
