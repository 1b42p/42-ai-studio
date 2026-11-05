import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { posix } from "node:path";
import type { SandboxSession } from "eve/sandbox";
import type {
  JustBashCommand,
  JustBashCommandContext,
  JustBashCommandResult,
} from "eve/sandbox/just-bash";
import { loadConfig } from "@/lib/config";
import { videoEvalReceipt } from "@/lib/video-eval/receipts";

export const VIDEO_EVAL_CONFIG_PATH = "/workspace/.eve/video-eval.json";

type Context = JustBashCommandContext;
type Composition = { id: string; width: number; height: number; fps: number; durationInFrames: number };
type Arguments = { positional: string[]; flags: Map<string, string> };

// Только протокол вызовов: ни React, ни кодеки, ни написанный моделью JS не исполняются.
const FIXTURE_PREFIX = "video-eval invocation-protocol fixture\n";
const MAX_SOURCE_BYTES = 1024 * 1024;
const MAX_FRAMES = 10_000;

function success(stdout = ""): JustBashCommandResult {
  return { exitCode: 0, stdout, stderr: "" };
}

function failure(message: string, exitCode = 1): JustBashCommandResult {
  return { exitCode, stdout: "", stderr: `video-eval: ${message}\n` };
}

function encodingFailure(output: string, message: string): JustBashCommandResult {
  const result = failure(message);
  return { ...result, stderr: result.stderr + videoEvalReceipt(output, loadConfig().eveEvalAuthToken!, 1) + "\n" };
}

function unsupported(command: string): JustBashCommandResult {
  return failure(`unsupported command: ${command}. This environment checks invocation protocol, not native execution.`, 127);
}

/** Доверенный текст Dockerfile передаёт сборщик; helper никогда не читает host FS. */
export async function prepareVideoEvalSandbox(sandbox: SandboxSession, dockerfileSource: string): Promise<void> {
  const required = ["package.json", "tsconfig.json", "remotion.config.ts", "src/index.ts", "src/Root.tsx"];
  const embedded = new Map<string, string>();
  for (const block of dockerfileSource.matchAll(/^# embed (\/opt\/remotion\/[^\n]+)\n([\s\S]*?)^# end embed\r?$/gm)) {
    const path = block[1].trim();
    if (!required.some((name) => path === `/opt/remotion/${name}`)) continue;
    const content = block[2].split("\n").filter((line) => line !== "")
      .map((line) => {
        if (!line.startsWith("#")) throw new Error(`Invalid Dockerfile embed: ${path}`);
        return line.replace(/^# ?/, "");
      }).join("\n") + "\n";
    // Комментарий и исполняемый Dockerfile должны описывать одни и те же bytes.
    const encoded = Buffer.from(content).toString("base64");
    if (!dockerfileSource.includes(`RUN echo '${encoded}' | base64 -d > ${path}`)) {
      throw new Error(`Dockerfile embed differs from its RUN command: ${path}`);
    }
    if (embedded.has(path)) throw new Error(`Duplicate Dockerfile embed: ${path}`);
    embedded.set(path, content);
  }
  for (const name of required) {
    if (!embedded.has(`/opt/remotion/${name}`)) throw new Error(`Missing Dockerfile embed: ${name}`);
  }

  const variables = new Map(Array.from(dockerfileSource.matchAll(/^ARG (\w+)=(.+)$/gm), (match) => [match[1], match[2].trim()]));
  const install = dockerfileSource.match(/^RUN npm install --save-exact[^\n]*\n((?:.*\\\r?\n)*.*)/m)?.[1];
  if (!install) throw new Error("Missing Remotion npm install in Dockerfile");
  const dependencies: Record<string, string> = {};
  for (const match of install.matchAll(/"([^"\n]+)"/g)) {
    const expanded = match[1].replace(/\$\{(\w+)\}/g, (_, name: string) => {
      const value = variables.get(name);
      if (value === undefined) throw new Error(`Unresolved Dockerfile ARG: ${name}`);
      return value;
    });
    const dependency = expanded.match(/^(@[^/]+\/[^@]+|[^@]+)@(\d+\.\d+\.\d+(?:-[\w.-]+)?)$/);
    if (!dependency) throw new Error(`Unsupported Dockerfile dependency: ${expanded}`);
    dependencies[dependency[1]] = dependency[2];
  }
  if (!dependencies.remotion) throw new Error("Missing Remotion version in Dockerfile");
  const packagePath = "/opt/remotion/package.json";
  const manifest = JSON.parse(embedded.get(packagePath)!) as Record<string, unknown>;
  embedded.set(packagePath, JSON.stringify({ ...manifest, dependencies }, null, 2) + "\n");
  for (const [name, version] of Object.entries(dependencies)) {
    embedded.set(`/opt/remotion/node_modules/${name}/package.json`, JSON.stringify({ name, version }) + "\n");
  }
  embedded.set("/opt/remotion/node_modules/.video-eval", "Invocation-protocol fixtures; no executable packages.\n");
  await sandbox.writeFiles({ files: Array.from(embedded, ([path, content]) => ({ path, content: new TextEncoder().encode(content) })) });
  const directories = await sandbox.run({ command: "mkdir -p /opt/remotion/node_modules/.bin /workspace/.eve" });
  if (directories.exitCode !== 0) throw new Error(`Cannot prepare virtual Remotion template: ${directories.stderr}`);
}

const BOOLEAN_FLAGS = new Set(["sequence", "muted", "overwrite", "disallow-parallel-encoding", "enforce-audio-track", "disable-shared-memory-capture", "rspack"]);
const VALUE_FLAGS = new Set(["frames", "frame", "scale", "image-format", "jpeg-quality", "concurrency", "codec", "crf", "pixel-format", "log", "output", "timeout", "x264-preset", "audio-codec", "audio-bitrate", "video-bitrate", "gl", "chrome-mode"]);

function parseArguments(args: string[]): Arguments {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (!arg.startsWith("-")) { positional.push(arg); continue; }
    const match = arg.match(/^--([\w-]+)(?:=(.*))?$/);
    if (!match || (!BOOLEAN_FLAGS.has(match[1]) && !VALUE_FLAGS.has(match[1]))) throw new Error(`unsupported option: ${arg}`);
    const name = match[1];
    let value = match[2];
    if (value === undefined) {
      if (BOOLEAN_FLAGS.has(name)) value = "true";
      else value = args[++index];
    }
    if (value === undefined || value === "" || value.startsWith("--")) throw new Error(`missing value for --${name}`);
    if (BOOLEAN_FLAGS.has(name) && value !== "true" && value !== "false") throw new Error(`invalid --${name}`);
    if (flags.has(name)) throw new Error(`duplicate --${name}`);
    flags.set(name, value);
  }
  return { positional, flags };
}

function pathFromCwd(ctx: Context, path: string): string {
  if (!path || /^[a-z][a-z\d+.-]*:/i.test(path) || /[\u0000-\u001f\\]/u.test(path)) throw new Error("only virtual filesystem paths are supported");
  return ctx.fs.resolvePath(ctx.cwd, path);
}

async function sourceFiles(ctx: Context, entry: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  let bytes = 0;
  async function visit(path: string): Promise<void> {
    if (files.has(path)) return;
    if (files.size >= 64) throw new Error("too many local source imports");
    const info = await ctx.fs.stat(path);
    if (!info.isFile || info.size > MAX_SOURCE_BYTES - bytes) throw new Error("invalid or oversized source file");
    const source = await ctx.fs.readFile(path);
    bytes += info.size;
    files.set(path, source);
    // Читаем только локальные статические импорты, никогда не import()/require() на host.
    for (const match of source.matchAll(/\b(?:import|export)\s+(?:[^;\n]*?\s+from\s*)?["'](\.[^"']+)["']/g)) {
      const base = ctx.fs.resolvePath(posix.dirname(path), match[1]);
      if (/\.(?:css|json|svg|png|jpe?g|mp[34]|wav)$/i.test(base)) continue;
      const candidates = [base, ...[".tsx", ".ts", ".jsx", ".js", "/index.tsx", "/index.ts", "/index.jsx", "/index.js"].map((suffix) => base + suffix)];
      let found = false;
      for (const candidate of candidates) {
        if (await ctx.fs.exists(candidate) && (await ctx.fs.stat(candidate)).isFile) {
          await visit(candidate);
          found = true;
          break;
        }
      }
      if (!found) throw new Error(`local source import not found: ${match[1]}`);
    }
  }
  await visit(entry);
  return files;
}

/** Маленькая арифметика над числами/const, а не eval, Function или исполнение JS. */
function numericExpression(
  expression: string, constants: Map<string, string>, seen = new Set<string>(),
  budget = { remaining: 4096, values: new Map<string, number>() },
): number {
  if (--budget.remaining < 0) throw new Error("numeric expression exceeds eval operation limit");
  const tokens = expression.match(/(?:\d+(?:\.\d+)?|\.\d+)|[A-Za-z_$][\w$]*|[()+*\/-]/g) ?? [];
  if (tokens.join("") !== expression.replace(/\s/g, "") || tokens.length > 64) throw new Error("composition metadata must be static numeric expressions");
  let index = 0;
  function atom(): number {
    if (--budget.remaining < 0) throw new Error("numeric expression exceeds eval operation limit");
    const token = tokens[index++];
    if (token === "+") return atom();
    if (token === "-") return -atom();
    if (token === "(") {
      const result = sum();
      if (tokens[index++] !== ")") throw new Error("unbalanced numeric expression");
      return result;
    }
    if (token !== undefined && /^(?:\d|\.)/.test(token)) return Number(token);
    if (token && constants.has(token) && !seen.has(token) && seen.size < 12) {
      const cached = budget.values.get(token);
      if (cached !== undefined) return cached;
      const value = numericExpression(constants.get(token)!, constants, new Set([...seen, token]), budget);
      budget.values.set(token, value);
      return value;
    }
    throw new Error("composition metadata must be static numeric expressions");
  }
  function product(): number {
    let result = atom();
    while (tokens[index] === "*" || tokens[index] === "/") {
      const operator = tokens[index++];
      const right = atom();
      result = operator === "*" ? result * right : result / right;
    }
    return result;
  }
  function sum(): number {
    let result = product();
    while (tokens[index] === "+" || tokens[index] === "-") {
      const operator = tokens[index++];
      const right = product();
      result = operator === "+" ? result + right : result - right;
    }
    return result;
  }
  const result = sum();
  if (index !== tokens.length || !Number.isFinite(result)) throw new Error("invalid numeric expression");
  return result;
}

function compositionMetadata(files: Map<string, string>, id: string): Composition {
  const constants = new Map<string, string>();
  for (const source of files.values()) {
    for (const match of source.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*(?::\s*number\s*)?=\s*([^;\n]+);?/g)) constants.set(match[1], match[2].trim());
  }
  const matches: Composition[] = [];
  for (const source of files.values()) {
    for (const tag of source.matchAll(/<(?:\w+\.)?Composition\b((?:[^"'{}>]|"[^"]*"|'[^']*'|\{[^{}]*\})*)\/?\s*>/g)) {
      const attributes = tag[1];
      const literalId = attributes.match(/\bid\s*=\s*(?:"([^"]+)"|'([^']+)'|\{\s*["']([^"']+)["']\s*\})/);
      if (!literalId || (literalId[1] ?? literalId[2] ?? literalId[3]) !== id) continue;
      const metadata: Composition = { id, width: 0, height: 0, fps: 0, durationInFrames: 0 };
      for (const name of ["width", "height", "fps", "durationInFrames"] as const) {
        const expression = attributes.match(new RegExp(`\\b${name}\\s*=\\s*\\{([^{}]+)\\}`))?.[1];
        if (!expression) throw new Error(`missing static Composition ${name}`);
        metadata[name] = numericExpression(expression, constants);
        if (metadata[name] <= 0 || (name !== "fps" && !Number.isSafeInteger(metadata[name]))) throw new Error(`invalid Composition ${name}`);
      }
      matches.push(metadata);
    }
  }
  if (matches.length !== 1) throw new Error(`expected one static Composition with id=${JSON.stringify(id)}; found ${matches.length}`);
  return matches[0];
}

function selectedFrames(value: string | undefined, duration: number): number[] {
  if (value === undefined) {
    if (duration > MAX_FRAMES) throw new Error("image sequence exceeds eval frame limit");
    return Array.from({ length: duration }, (_, index) => index);
  }
  const frames = new Set<number>();
  for (const part of value.split(",")) {
    const match = part.match(/^(\d+)(?:-(\d*))?$/);
    if (!match) throw new Error("invalid --frames; use frame numbers or inclusive ranges");
    const start = Number(match[1]);
    const end = match[2] === undefined ? start : match[2] === "" ? duration - 1 : Number(match[2]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || end >= duration || end - start >= MAX_FRAMES) throw new Error("--frames outside composition or eval frame limit");
    for (let frame = start; frame <= end; frame++) {
      frames.add(frame);
      if (frames.size > MAX_FRAMES) throw new Error("image sequence exceeds eval frame limit");
    }
  }
  return [...frames].sort((left, right) => left - right);
}

function configurationSignature(renderFails: boolean): string {
  const token = loadConfig().eveEvalAuthToken;
  if (!loadConfig().appVideoEvalSandbox || !token) throw new Error("video eval sandbox is disabled");
  return createHmac("sha256", token.trim()).update(`studio-video-eval:v1:${renderFails}`).digest("hex");
}

/** Модель видит настройку, но не может изменить её без серверного секрета. */
export function videoEvalConfiguration(renderFails: boolean): string {
  return JSON.stringify({ renderFails, signature: configurationSignature(renderFails) });
}

async function renderFails(ctx: Context): Promise<boolean> {
  if (!await ctx.fs.exists(VIDEO_EVAL_CONFIG_PATH)) throw new Error("missing video eval configuration");
  const stat = await ctx.fs.stat(VIDEO_EVAL_CONFIG_PATH);
  if (!stat.isFile || stat.size > 4096) throw new Error("invalid video eval configuration");
  const config: unknown = JSON.parse(await ctx.fs.readFile(VIDEO_EVAL_CONFIG_PATH));
  if (typeof config !== "object" || config === null || Array.isArray(config) ||
    !("renderFails" in config) || typeof config.renderFails !== "boolean" ||
    !("signature" in config) || typeof config.signature !== "string" ||
    !/^[0-9a-f]{64}$/.test(config.signature)) throw new Error("invalid video eval configuration");
  const expected = Buffer.from(configurationSignature(config.renderFails), "hex");
  if (!timingSafeEqual(expected, Buffer.from(config.signature, "hex"))) throw new Error("video eval configuration was modified");
  return config.renderFails;
}

async function writeFixture(ctx: Context, output: string, metadata: object, overwrite: boolean): Promise<void> {
  if (!overwrite && await ctx.fs.exists(output)) throw new Error(`output already exists: ${output}`);
  await ctx.fs.mkdir(posix.dirname(output), { recursive: true });
  await ctx.fs.writeFile(output, FIXTURE_PREFIX + JSON.stringify(metadata) + "\n");
}

async function render(kind: "render" | "still", args: string[], ctx: Context): Promise<JustBashCommandResult> {
  const { positional, flags } = parseArguments(args);
  const outputArg = flags.get("output") ?? positional[2];
  if (positional.length < 2 || positional.length > 3 || !outputArg || (flags.has("output") && positional.length === 3)) throw new Error("pass an existing entry point, Composition id and one output path");
  if (kind === "still" && (flags.has("frames") || flags.has("sequence"))) throw new Error("still takes --frame, not --frames/--sequence");
  if (kind === "render" && flags.has("frame")) throw new Error("render takes --frames, not --frame");
  if (kind === "still" && flags.has("frame") && !/^\d+$/.test(flags.get("frame")!)) throw new Error("--frame must be one nonnegative integer");
  for (const name of ["concurrency", "timeout"] as const) {
    const value = flags.get(name);
    if (value !== undefined && (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1)) throw new Error(`--${name} must be a positive integer`);
  }
  if (flags.has("crf") && (!/^\d+$/.test(flags.get("crf")!) || Number(flags.get("crf")) > 51)) throw new Error("--crf must be an integer from 0 to 51");
  if (flags.has("codec") && flags.get("codec") !== "h264") throw new Error("only h264 video invocation protocol is supported");
  if (flags.has("log") && !["error", "warn", "info", "verbose"].includes(flags.get("log")!)) throw new Error("invalid --log level");
  const entry = pathFromCwd(ctx, positional[0]);
  const output = pathFromCwd(ctx, outputArg);
  const files = await sourceFiles(ctx, entry);
  if (!/\bregisterRoot\s*\(/.test(files.get(entry)!)) throw new Error("entry point must call registerRoot; JavaScript is not executed in this protocol fixture");
  const metadata = compositionMetadata(files, positional[1]);
  const scale = Number(flags.get("scale") ?? 1);
  if (!Number.isFinite(scale) || scale <= 0 || scale > 16) throw new Error("--scale must be greater than 0 and at most 16");
  const quality = Number(flags.get("jpeg-quality") ?? 80);
  if (!Number.isInteger(quality) || quality < 0 || quality > 100) throw new Error("--jpeg-quality must be an integer from 0 to 100");
  const width = Math.round(metadata.width * scale);
  const height = Math.round(metadata.height * scale);
  if (width < 1 || height < 1) throw new Error("scaled image dimensions must be positive");
  const framesValue = flags.get("frames");
  // Список отдельных кадров включает sequence автоматически; диапазон — только с --sequence.
  const sequence = flags.get("sequence") === "true" || (framesValue !== undefined && !framesValue.includes("-"));
  const images = kind === "still" || sequence;
  const imageFormat = flags.get("image-format") ?? (kind === "still" && /\.png$/i.test(output) ? "png" : "jpeg");
  if (imageFormat !== "jpeg" && imageFormat !== "png") throw new Error("only jpeg/png image-format is supported");
  const frames = kind === "still" ? selectedFrames(flags.get("frame") ?? "0", metadata.durationInFrames)
    : framesValue !== undefined || sequence ? selectedFrames(framesValue, metadata.durationInFrames) : undefined;
  if (kind === "still" && frames!.length !== 1) throw new Error("--frame must select exactly one frame");
  if (!images && !/\.mp4$/i.test(output)) throw new Error("only MP4 video output is supported; use --sequence for images");
  if (kind === "still" && !(imageFormat === "png" ? /\.png$/i : /\.jpe?g$/i).test(output)) throw new Error("still output extension must match --image-format");
  if (!images && await renderFails(ctx)) return encodingFailure(output, "render failed while encoding the composition; MP4 was not created.");
  const sourceHash = createHash("sha256").update(JSON.stringify([...files])).digest("hex");
  const fixture = { protocolOnly: true, ...metadata, width, height, sourceHash, scale, imageFormat, jpegQuality: quality };
  const overwrite = flags.get("overwrite") !== "false";
  if (sequence && kind === "render") {
    const padding = String(frames!.at(-1)!).length;
    await ctx.fs.mkdir(output, { recursive: true });
    for (const frame of frames!) {
      ctx.signal?.throwIfAborted();
      await writeFixture(ctx, posix.join(output, `element-${String(frame).padStart(padding, "0")}.${imageFormat}`), {
        ...fixture, frame,
        simulatedReview: "Текст читается на контрастном фоне, не обрезан. Элементы не перекрываются, кадр не пустой. Это текстовая фикстура просмотра, не оценка настоящего изображения.",
      }, overwrite);
    }
  } else {
    await writeFixture(ctx, output, { ...fixture, ...(kind === "still" ? { frame: frames![0] } : { frames: frames ?? "all" }) }, overwrite);
  }
  const receipt = images ? "" : `${videoEvalReceipt(output, loadConfig().eveEvalAuthToken!)}\n`;
  return success(`video-eval: invocation protocol accepted; fixture written to ${output}. Native rendering was not performed.\n${receipt}`);
}

async function probe(args: string[], ctx: Context): Promise<JustBashCommandResult> {
  const flags = new Map<string, string>();
  const inputs: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (["-hide_banner", "-show_streams", "-show_format"].includes(arg)) { flags.set(arg, "true"); continue; }
    if (["-v", "-loglevel", "-show_entries", "-of", "-print_format", "-select_streams"].includes(arg)) {
      const value = args[++index];
      if (!value || value.startsWith("-")) throw new Error(`missing ffprobe ${arg} value`);
      flags.set(arg, value);
    } else if (arg.startsWith("-")) throw new Error(`unsupported ffprobe option: ${arg}`);
    else inputs.push(arg);
  }
  if (inputs.length !== 1) throw new Error("ffprobe requires one existing nonempty virtual file");
  const info = await ctx.fs.stat(pathFromCwd(ctx, inputs[0]));
  if (!info.isFile || info.size === 0) throw new Error("ffprobe input must be an existing nonempty file");
  if (info.size > MAX_SOURCE_BYTES) throw new Error("ffprobe fixture is oversized");
  const source = await ctx.fs.readFile(pathFromCwd(ctx, inputs[0]));
  if (!source.startsWith(FIXTURE_PREFIX)) throw new Error("ffprobe accepts only video-eval protocol fixtures");
  const metadata = JSON.parse(source.slice(FIXTURE_PREFIX.length)) as Record<string, unknown>;
  for (const key of ["width", "height", "fps", "durationInFrames"] as const) {
    if (typeof metadata[key] !== "number" || !Number.isFinite(metadata[key]) || metadata[key] <= 0) {
      throw new Error("invalid video-eval metadata");
    }
  }
  if (metadata.frame !== undefined || metadata.protocolOnly !== true) throw new Error("ffprobe input must be a video fixture");
  const frameCount = Array.isArray(metadata.frames) ? metadata.frames.length : metadata.durationInFrames as number;
  const duration = (frameCount / (metadata.fps as number)).toFixed(6);
  const stream: Record<string, string | number> = { index: 0, codec_name: "h264", codec_type: "video", width: metadata.width as number, height: metadata.height as number, r_frame_rate: `${metadata.fps}/1`, avg_frame_rate: `${metadata.fps}/1`, duration, nb_frames: String(frameCount) };
  const format: Record<string, string | number> = { duration, size: String(info.size), format_name: "mov,mp4,m4a,3gp,3g2,mj2" };
  const selection = flags.get("-select_streams");
  if (selection && !["v", "v:0", "0", "a", "a:0"].includes(selection)) throw new Error("unsupported ffprobe stream selector");
  const streams = selection?.startsWith("a") ? [] : [stream];
  const entries = flags.get("-show_entries");
  function fields(section: string, values: Record<string, string | number>): Record<string, string | number> {
    if (!entries) return values;
    const selected = entries.split(":").find((part) => part.split("=", 1)[0] === section);
    if (selected === undefined) return {};
    const names = selected.split("=")[1]?.split(",");
    return names === undefined ? values : Object.fromEntries(Object.entries(values).filter(([key]) => names.includes(key)));
  }
  const outputStreams = streams.map((value) => fields("stream", value)).filter((value) => Object.keys(value).length > 0);
  const outputFormat = fields("format", format);
  const output = flags.get("-of") ?? flags.get("-print_format") ?? "default";
  const sections = [...outputStreams, ...(Object.keys(outputFormat).length ? [outputFormat] : [])];
  let stdout: string;
  if (output === "json") stdout = JSON.stringify({ streams: outputStreams, format: outputFormat }) + "\n";
  else if (/^default(?::(?:nw|noprint_wrappers|nk|nokey)=[01])*$/.test(output)) {
    const noKeys = /(?:^|:)(?:nk|nokey)=1(?:$|:)/.test(output);
    stdout = sections.flatMap((section) => Object.entries(section).map(([key, value]) => noKeys ? String(value) : `${key}=${value}`)).join("\n") + "\n";
  } else throw new Error(`unsupported ffprobe output format: ${output}`);
  return { exitCode: 0, stdout, stderr: "video-eval: invocation-protocol metadata; bytes and codecs were not validated.\n" };
}

async function remotion(args: string[], ctx: Context): Promise<JustBashCommandResult> {
  try {
    const [command, ...rest] = args;
    if (command === "render" || command === "still") return await render(command, rest, ctx);
    if (command === "ffprobe") return await probe(rest, ctx);
    if (command === "ffmpeg") {
      const options = rest.filter((arg) => arg !== "-hide_banner");
      if (options.length === 1 && options[0] === "-version") return success("ffmpeg version 7.1 (video-eval invocation-protocol fixture; no binary)\n");
      if (options.length === 1 && options[0] === "-encoders") return success("Encoders (video-eval protocol fixture, not a capability check):\n V..... libx264 H.264\n A..... aac AAC\n");
      if (await renderFails(ctx)) return encodingFailure(pathFromCwd(ctx, rest.at(-1) ?? ""), "ffmpeg encoding failed; MP4 was not created.");
      return unsupported("remotion ffmpeg encoding");
    }
    return unsupported(`remotion ${command ?? ""}`);
  } catch (error) {
    ctx.signal?.throwIfAborted();
    // Ошибки принадлежат виртуальной FS; никакие host-команды не запускались.
    return failure(error instanceof Error ? error.message : "virtual invocation failed");
  }
}

export const videoEvalCommands: JustBashCommand[] = [
  {
    name: "npx",
    async execute(args, ctx) {
      const command = [...args];
      while (["--no-install", "--yes", "-y", "--"].includes(command[0])) command.shift();
      return command.shift() === "remotion" ? remotion(command, ctx) : unsupported(`npx ${args.join(" ")}`);
    },
  },
  { name: "sandbox-vcpu", async execute(args) { return args.length === 0 ? success("2\n") : failure("sandbox-vcpu takes no arguments", 2); } },
  ...["npm", "node"].map((name): JustBashCommand => ({ name, async execute() { return unsupported(name); } })),
];
