// Offline recorder, never an eval executor. Run as a mapped root user to avoid
// putting host account names in GNU ls/stat recordings:
// unshare --user --map-root-user node evals/fixtures/music/record-contract.cjs <hashed-render-project>
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const project = require("./project.json");
const audit = require("./integration.json");
const frames = require("./frames.json");
const original = path.resolve(process.argv[2]);
const repo = path.resolve(__dirname, "../../..");
const virtual = "/workspace/calm-bed";
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
if (process.getuid() !== 0) throw new Error("Run in a mapped root user namespace.");
for (const [file, metadata] of Object.entries(audit.files)) {
  if (hash(fs.readFileSync(path.join(original, file))) !== metadata.sha256) throw new Error(`Wrong artifact: ${file}`);
}
for (const [file, digest] of Object.entries(project.sourceHashes)) {
  if (hash(project.files[file]) !== digest) throw new Error(`Wrong source: ${file}`);
}
const root = fs.mkdtempSync("/tmp/opencode/music-contract-");
for (const [file, content] of Object.entries(project.files)) {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), content);
}
fs.copyFileSync(path.join(__dirname, "SPEC.md"), path.join(root, "SPEC.md"));
fs.symlinkSync(path.join(original, "node_modules"), path.join(root, "node_modules"));
for (const file of Object.keys(audit.files)) {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.copyFileSync(path.join(original, file), path.join(root, file));
}
fs.mkdirSync(path.join(root, "public/music"), { recursive: true });
fs.copyFileSync(path.join(original, "public/music/bg.wav"), path.join(root, "public/music/bg.wav"));
const mediaInputs = [];
for (const source of audit.sources) {
  const bytes = fs.readFileSync(path.join(original, source.path));
  if (hash(bytes) !== source.sha256) throw new Error(`Wrong voice evidence: ${source.path}`);
  fs.writeFileSync(path.join(root, source.path), bytes);
  mediaInputs.push({ path: source.path, size: bytes.length, sha256: source.sha256 });
}
for (const frame of frames.frames) {
  const bytes = Buffer.from(frame.base64, "base64");
  if (hash(bytes) !== frame.sha256) throw new Error(`Wrong frame evidence: ${frame.path}`);
  const file = path.join(root, "out/frames-1", path.basename(frame.path));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
}
const cli = path.join(original, "node_modules/.bin/remotion");
function run(executable, args) {
  const result = spawnSync(executable, args.map(arg => arg.replaceAll(virtual, root)), {
    cwd: root, encoding: "utf8", timeout: 60000, env: { ...process.env, LC_ALL: "C" },
    stdio: ["ignore", "pipe", "pipe"], maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  return { status: "completed", exitCode: result.status, stdout: result.stdout.replaceAll(root, virtual),
    stderr: result.stderr.replaceAll(root, virtual), truncated: false };
}
const probes = [];
function probe(id, files, entries, format, select, full = false, quiet = true) {
  const args = ["ffprobe", ...(quiet ? ["-v", "error"] : []), ...(select ? ["-select_streams", select] : []),
    ...(full ? ["-show_streams", "-show_format"] : entries ? ["-show_entries", entries] : []),
    ...(format ? ["-of", format] : [])];
  const output = run(cli, [...args, files[0]]);
  if (output.exitCode !== 0) throw new Error(`Probe failed: ${id}`);
  for (const file of files.slice(1)) {
    if (JSON.stringify(run(cli, [...args, file])) !== JSON.stringify(output)) throw new Error(`Cannot share response: ${id}`);
  }
  probes.push({ id, files, entries, format, select, full, quiet, args, output });
}
const final = ["out/final.mp4"];
const stems = ["out/voice-only.wav", "out/music-only.wav"];
probe("whole-json", final, null, "json", null, true, false);
probe("whole-json-quiet", final, null, "json", null, true);
probe("whole-default", final, null, "default", null, true);
for (const format of ["json", "default=nw=1"]) {
  probe(`selected-${format}`, final, "stream=codec_name,codec_type,width,height,duration:format=duration", format);
  probe(`stem-${format}`, stems, "stream=codec_type,duration", format);
}
probe("selected-stream", final, "stream=codec_name,codec_type,width,height,duration", "default=nw=1");
probe("voiceover-json", final, "stream=codec_type,duration:format=duration", "json");
for (const format of ["default=nw=1", "csv=p=0", "json"]) probe(`duration-${format}`, final, "format=duration", format);
probe("audio", final, "stream=codec_name,duration", "default=nw=1", "a:0");
probe("video", final, "stream=codec_name,width,height,duration", "default=nw=1", "v:0");
probe("stem-codec", stems, "stream=codec_name,codec_type,duration", "default=nw=1");
probe("stem-duration", stems, "format=duration", "csv=p=0");
probe("dimensions", final, "stream=width,height", "csv=p=0");
probe("types", final, "stream=codec_type", "csv=p=0");
probe("human", final, null, null, null, false, false);
const levels = [];
for (const file of stems) {
  for (const scope of ["full", "input", "output"]) {
    const args = ["ffmpeg", ...(scope === "input" ? ["-ss", "1", "-t", "2"] : []), "-i", file,
      ...(scope === "output" ? ["-ss", "1", "-t", "2"] : []), "-vn", "-af", "loudnorm=print_format=json", "-f", "null", "-"];
    const output = run(cli, args);
    if (output.exitCode !== 0) throw new Error(`Level failed: ${file} ${scope}`);
    const measurement = JSON.parse(output.stderr.match(/\{\s*"input_i"[\s\S]*?\}/g).at(-1));
    levels.push({ file, scope, args, output, measurement });
  }
}
const pixels = {};
const bootstrap = run("uv", ["run", "--no-project", "--with", "pillow==12.0.0", "python", "-c", "pass"]);
if (bootstrap.exitCode !== 0) throw new Error(bootstrap.stderr);
for (const absolute of [false, true]) {
  const inputs = frames.frames.map(frame => `${absolute ? `${virtual}/` : ""}out/frames-1/${path.basename(frame.path)}`);
  const output = run("uv", ["run", "--no-project", "--with", "pillow==12.0.0", path.join(repo, "agent/skills/frame-review/scripts/check-frames.py"), ...inputs]);
  if (output.exitCode !== 0) throw new Error(`Pixel checker failed: ${output.stderr}`);
  pixels[absolute ? "absolute" : "relative"] = output;
}
const diagnostics = [];
for (const args of [
  ["ls", "-la"], ["ls", "-la", "src"], ["ls", "-la", `${virtual}/public/music/bg.wav`],
  ["ls", "-lh", "out/music-only.wav"], ["stat", "out/music-only.wav"], ["rg", "--files", "src"],
  ["ls", "-l", "public/voice", "public/music"],
]) diagnostics.push({ args, output: run(args[0], args.slice(1)) });
const decodeFailure = run(cli, ["ffmpeg", "-i", "out/final.mp4", "-f", "null", "-"]);
const records = { sourceSha256: project.sourceSha256, mediaInputs, artifacts: Object.fromEntries(Object.entries(audit.files).map(([file, metadata]) => [file, metadata.sha256])),
  checkerSha256: hash(fs.readFileSync(path.join(repo, "agent/skills/frame-review/scripts/check-frames.py"))),
  probes, levels, pixels, diagnostics, decodeFailure };
fs.writeFileSync(path.join(__dirname, "contract-records.json"), JSON.stringify(records, null, 2) + "\n");
console.log(JSON.stringify({ probes: probes.length, levels: levels.length, diagnostics: diagnostics.length, sourceSha256: project.sourceSha256 }));
