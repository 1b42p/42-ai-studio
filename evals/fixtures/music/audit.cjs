// Offline, real-media audit. Never used as an eval tool executor or matcher.
// node evals/fixtures/music/audit.cjs <new-output-dir> <remotion-node_modules> <evidence-dir>
// Evidence: voice.mp3, voice.words.json, calm-24s-18.wav (hashes in integration.json).
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { spawnSync } = require("node:child_process");

const [outputArg, dependenciesArg, evidenceArg] = process.argv.slice(2);
if (!outputArg || !dependenciesArg || !evidenceArg) {
  throw new Error("Usage: node audit.cjs <new-output-dir> <remotion-node_modules> <evidence-dir>");
}
const output = path.resolve(outputArg);
const dependencies = path.resolve(dependenciesArg);
const evidence = path.resolve(evidenceArg);
const project = require("./project.json");
const expected = require("./integration.json");
const frames = require("./frames.json");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const input = (name, expectedHash) => {
  const file = path.join(evidence, name);
  if (hash(fs.readFileSync(file)) !== expectedHash) throw new Error(`Evidence hash mismatch: ${name}`);
  return file;
};
const voice = input("voice.mp3", expected.sourceVoice.sha256);
const music = input("calm-24s-18.wav", expected.sourceMusic.sha256);
if (JSON.parse(fs.readFileSync(path.join(dependencies, "remotion/package.json"))).version !== project.remotionVersion) {
  throw new Error(`Requires Remotion ${project.remotionVersion}`);
}
for (const [file, expectedHash] of Object.entries(project.sourceHashes)) {
  if (hash(project.files[file]) !== expectedHash) throw new Error(`Source hash mismatch: ${file}`);
}
fs.mkdirSync(output); // Refuse an existing directory instead of overwriting unrelated files.
fs.symlinkSync(dependencies, path.join(output, "node_modules"), "dir");
for (const [file, content] of Object.entries(project.files)) {
  fs.mkdirSync(path.dirname(path.join(output, file)), { recursive: true });
  fs.writeFileSync(path.join(output, file), content);
}
fs.copyFileSync(path.join(__dirname, "SPEC.md"), path.join(output, "SPEC.md"));
fs.mkdirSync(path.join(output, "public/music"), { recursive: true });
const cli = path.join(dependencies, ".bin/remotion");
const commands = [];
function run(args) {
  commands.push(args);
  const result = spawnSync(cli, args, { cwd: output, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`${args[0]} failed: ${result.error?.message ?? result.stderr}`);
  return `${result.stdout}\n${result.stderr}`;
}
function loudness(args) {
  const result = run(["ffmpeg", ...args, "-f", "null", "-"]);
  const json = result.match(/\{\s*"input_i"[\s\S]*?\}/g)?.at(-1);
  if (!json) throw new Error("Missing loudnorm result");
  return JSON.parse(json);
}
run(["ffmpeg", "-y", "-i", music, "-t", "20", "-c:a", "pcm_s16le", "public/music/bg.wav", "-loglevel", "error"]);
for (const [index, source] of expected.sources.entries()) {
  const [start, end] = source.sourceRangeSeconds;
  run(["ffmpeg", "-y", "-ss", String(start), "-t", String(Number((end - start).toFixed(2))), "-i", voice,
    "-af", "apad,atrim=duration=4.166", "-c:a", "libmp3lame", "-b:a", "96k", `public/voice/scene-0${index + 1}.mp3`, "-loglevel", "error"]);
}
run(["render", "src/index.ts", "Main", "out/frames-1", "--frames=0,100,150,300,450,599",
  '--props={"fixtureVisualOnly":true}', "--image-format=jpeg", "--jpeg-quality=90", "--concurrency=2"]);
for (const mode of ["voice-only", "music-only", "mix"]) {
  run(["render", "src/index.ts", "Main", mode === "mix" ? "out/final.mp4" : `out/${mode}.wav`,
    `--props=${JSON.stringify({ audioMode: mode })}`, "--concurrency=2"]);
}
const level = (file, options = []) => loudness([...options, "-i", file, "-vn", "-af", "loudnorm=print_format=json"]);
const outsideFilter = "[0:a]atrim=start=4.91:end=5.12,asetpts=PTS-STARTPTS[a];[0:a]atrim=start=9.91:end=10.12,asetpts=PTS-STARTPTS[b];[0:a]atrim=start=14.91:end=15.12,asetpts=PTS-STARTPTS[c];[a][b][c]concat=n=3:v=0:a=1,loudnorm=print_format=json";
const measurements = {
  voiceFull: level("out/voice-only.wav"),
  voiceSpeech: level("out/voice-only.wav", ["-ss", "1", "-t", "2"]),
  musicSpeech: level("out/music-only.wav", ["-ss", "1", "-t", "2"]),
  musicOutside: loudness(["-i", "out/music-only.wav", "-vn", "-filter_complex", outsideFilter]),
  mix: level("out/final.mp4"),
};
const report = {
  sourceSha256: project.sourceSha256,
  provenance: expected.note,
  measurements,
  frames: frames.frames.map((frame) => ({
    number: frame.number,
    sha256: hash(fs.readFileSync(path.join(output, "out/frames-1", path.basename(frame.path)))),
    expectedSha256: frame.sha256,
  })),
  probe: JSON.parse(run(["ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", "out/final.mp4"])),
  commands,
};
fs.writeFileSync(path.join(output, "audit.json"), JSON.stringify(report, null, 2) + "\n");
if (report.frames.some((frame) => frame.sha256 !== frame.expectedSha256)) {
  throw new Error("Reference frame bytes changed; see audit.json");
}
const video = report.probe.streams.find((stream) => stream.codec_type === "video");
const audio = report.probe.streams.find((stream) => stream.codec_type === "audio");
if (!video || !audio || video.width !== 1920 || video.height !== 1080 ||
  [video, audio].some((stream) => Math.abs(Number(stream.duration) - 20) > 0.1)) {
  throw new Error("Final video stream contract failed; see audit.json");
}
if (Math.abs(Number(measurements.voiceFull.input_i) + 16) > 2 ||
  Number(measurements.voiceSpeech.input_i) - Number(measurements.musicSpeech.input_i) < 8 ||
  Math.abs(Number(measurements.musicOutside.input_i) + 18) > 2 || Number(measurements.mix.input_tp) > -1) {
  throw new Error("Real audio routes failed loudness requirements; see audit.json");
}
console.log(path.join(output, "audit.json"));
