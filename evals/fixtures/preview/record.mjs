// Record immutable JPEGs and all supported MP4 variants with Remotion 4.0.538.
// node evals/fixtures/preview/record.mjs /path/to/remotion/project /path/to/chrome [--videos-only]
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const fixture = fileURLToPath(new URL(".", import.meta.url));
const require = createRequire(resolve(process.argv[2], "package.json"));
const { bundle } = require("@remotion/bundler");
const { selectComposition, renderStill, renderMedia } = require("@remotion/renderer");
const browserExecutable = process.argv[3];
if (require("remotion/package.json").version !== "4.0.538") throw new Error("Remotion 4.0.538 required");
const source = await readFile(join(fixture, "index.tsx"), "utf8");
const temporary = await mkdtemp(join(tmpdir(), "preview-frames-"));
const serveUrl = await bundle({ entryPoint: join(fixture, "index.tsx"), webpackOverride: config => ({ ...config, resolve: { ...config.resolve, modules: [resolve(process.argv[2], "node_modules"), "node_modules"] } }) });
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const frames = [];
const previews = [];
for (const seconds of process.argv.includes("--videos-only") ? [] : [30, 120]) {
  const inputProps = { seconds };
  const composition = await selectComposition({ serveUrl, id: "Main", inputProps, browserExecutable });
  const numbers = [0, seconds * 5, seconds * 10, seconds * 15, seconds * 20, seconds * 30 - 1];
  for (const frame of numbers) {
    const name = `element-${String(frame).padStart(4, "0")}.jpeg`;
    const directory = join(temporary, String(seconds));
    await mkdir(directory, { recursive: true });
    const output = join(directory, name);
    await renderStill({ serveUrl, composition, inputProps, frame, imageFormat: "jpeg", jpegQuality: 90, output, browserExecutable });
    const bytes = await readFile(output);
    const report = execFileSync("uv", ["run", "--with", "pillow==11.3.0", "agent/skills/frame-review/scripts/check-frames.py", output], { encoding: "utf8" });
    const pixel = JSON.parse(report.split("\n").find(line => line.startsWith("{")));
    frames.push({ seconds, frame, path: `/workspace/preview-coffee-${seconds}/out/frames-1/${name}`, width: 1920, height: 1080, size: bytes.length, sha256: sha256(bytes), base64: bytes.toString("base64"), extrema: pixel.extrema });
    const previewOutput = join(directory, `key-${frame}.jpg`);
    await renderStill({ serveUrl, composition, inputProps, frame, imageFormat: "jpeg", jpegQuality: 85, scale: 0.5, output: previewOutput, browserExecutable });
    const previewBytes = await readFile(previewOutput);
    previews.push({ seconds, frame, path: `/workspace/preview-coffee-${seconds}/out/key-${frame}.jpg`, width: 960, height: 540, size: previewBytes.length, sha256: sha256(previewBytes), base64: previewBytes.toString("base64") });
  }
}
if (frames.length) await writeFile(join(fixture, "frames.json"), JSON.stringify({ remotion: "4.0.538", sourceSha256: sha256(source), frames, previews }, null, 2) + "\n");
const videos = [];
const sourceSha256 = sha256(source);
const existing = JSON.parse(await readFile(join(fixture, "integration.json"), "utf8"));
for (const [seconds, draft] of [[30, false], [30, true], [120, false], [120, true]]) {
  const renderOptions = { codec: "h264", scale: draft ? 0.5 : 1, concurrency: 2,
    ...(draft ? { x264Preset: "superfast", crf: 32 } : {}) };
  const previous = existing.sourceSha256 === sourceSha256 && existing.videos.find(video => video.seconds === seconds && video.draft === draft);
  // The original final recording used these same default encoding options.
  // Drafts without an explicit encoding receipt must be recorded again.
  if (previous && JSON.stringify(previous.renderOptions ?? (!draft ? renderOptions : null)) === JSON.stringify(renderOptions)) {
    videos.push({ ...previous, renderOptions });
    continue;
  }
  const inputProps = { seconds };
  const composition = await selectComposition({ serveUrl, id: "Main", inputProps, browserExecutable });
  const name = draft ? "draft" : "final";
  const outputLocation = join(temporary, `${seconds}-${name}.mp4`);
  console.log(`Recording ${seconds}s ${name}: ${JSON.stringify(renderOptions)}`);
  await renderMedia({ serveUrl, composition, inputProps, browserExecutable, outputLocation, ...renderOptions });
  const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", outputLocation], { encoding: "utf8" }));
  probe.format.filename = `out/${name}.mp4`;
  videos.push({ seconds, draft, path: `out/${name}.mp4`, size: (await stat(outputLocation)).size,
    sha256: sha256(await readFile(outputLocation)), renderOptions, probe });
}
await writeFile(join(fixture, "integration.json"), JSON.stringify({ sourceSha256, videos }, null, 2) + "\n");
console.log(`Saved ${videos.length} video recordings${frames.length ? ` and ${frames.length} review JPEGs` : ""}; new originals: ${temporary}`);
