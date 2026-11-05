import { posix } from "node:path";
import type { EveEvalStreamEvent, EveEvalToolCall, EveEvalTurn } from "eve/evals";
import { parseSandboxLinks, resolveSandboxFilePath } from "../../lib/media/sandbox-path";
import { videoEvalArtifacts, videoEvalRenderResults } from "../../lib/video-eval/receipts";

export function isFullRender(command: unknown): boolean {
  return typeof command === "string" && commands(command).some((argv) => videoOutput(argv) !== undefined);
}

export function isFramePath(path: unknown): boolean {
  return typeof path === "string" && /\.(?:jpe?g|png)$/iu.test(path);
}

/** Разбор обычных CLI-команд, не выполнение shell. Сохраняет пути в обоих видах кавычек. */
function commands(command: string): string[][] {
  const parts = command.match(/(?:"(?:\\.|[^"\\])*"|'[^']*'|[^\s"';&|()])+|[;&|()\n]+/g) ?? [];
  const result: string[][] = [[]];
  for (const part of parts) {
    if (/^[;&|()\n]+$/.test(part)) result.push([]);
    else result.at(-1)!.push(part.replace(/"((?:\\.|[^"\\])*)"|'([^']*)'/g,
      (_, double: string | undefined, single: string | undefined) => single ?? double!.replace(/\\(["\\$`])/g, "$1")));
  }
  return result.filter((part) => part.length > 0);
}

/** Любое кодирование MP4, в том числе диапазон кадров и альтернативная сборка FFmpeg. */
function videoOutput(argv: string[]): string | undefined {
  const remotion = argv.findIndex((word) => posix.basename(word) === "remotion");
  const ffmpeg = argv.findIndex((word) => posix.basename(word) === "ffmpeg");
  const render = remotion >= 0 && argv[remotion + 1] === "render";
  if (!render && ffmpeg < 0) return undefined;
  if (render && argv.some((word) => word === "--sequence" || word === "--sequence=true")) return undefined;
  if (render) {
    const framesFlag = argv.findIndex((word) => word === "--frames" || word.startsWith("--frames="));
    const frames = framesFlag < 0 ? undefined : argv[framesFlag].split("=")[1] ?? argv[framesFlag + 1];
    if (frames !== undefined && !frames.includes("-")) return undefined;
  }
  const output = argv.at(-1);
  if (ffmpeg >= 0 && /\.mp4$/iu.test(output ?? "")) return output;
  if (render) {
    const outputFlag = argv.findIndex((word) => word === "--output" || word.startsWith("--output="));
    if (outputFlag >= 0) return argv[outputFlag].split("=")[1] ?? argv[outputFlag + 1];
    return argv.slice(remotion + 2).find((word) => /\.mp4$/iu.test(word));
  }
  return undefined;
}

export function workspacePath(path: string, cwd = "/workspace"): string | undefined {
  if (/^[a-z][a-z\d+.-]*:/iu.test(path) || /[\\\u0000-\u001f]/u.test(path)) return undefined;
  const absolute = posix.resolve(cwd, path);
  return absolute.startsWith("/workspace/") ? absolute : undefined;
}

/** Путь ссылки нормализуется от /workspace, как в приложении, а не от cwd bash. */
export function videoLinks(message: string | undefined): string[] {
  return parseSandboxLinks(message ?? "", { includeUnusedDefinitions: false }).flatMap((link) =>
    link.kind === "file" && /\.mp4$/iu.test(link.path) ? [link.path] : []);
}

/** Подписанное подтверждение записи, а не успешный exitCode всей shell-цепочки. */
export function renderOutputs(calls: readonly EveEvalToolCall[]): string[] {
  const outputs: string[] = [];
  const token = process.env.EVE_EVAL_AUTH_TOKEN?.trim();
  if (!token) return outputs;
  for (const call of calls) {
    if (call.name !== "bash" || call.status !== "completed" || typeof call.output !== "object" ||
      call.output === null || !("stdout" in call.output) || typeof call.output.stdout !== "string") continue;
    for (const output of videoEvalArtifacts(call.output.stdout, token)) {
      const path = workspacePath(output);
      if (path) outputs.push(path);
    }
  }
  return outputs;
}

export function recreatesProject(command: unknown): boolean {
  if (typeof command !== "string") return false;
  return commands(command).some((argv) =>
    argv.some((word) => /(?:^|\/)create-video(?:@[^/]*)?$/.test(word)) ||
    (argv.some((word) => posix.basename(word) === "cp") &&
      argv.some((word) => /^\/opt\/remotion(?:\/|$)/.test(word))));
}

export function planBeforeWork(events: readonly EveEvalStreamEvent[]): boolean {
  let hasPlan = false;
  for (const event of events) {
    if (event.type === "message.completed" && typeof event.data.message === "string" &&
      event.data.message.trim().length > 0) hasPlan = true;
    if (event.type === "actions.requested" && event.data.actions.some((action) =>
      action.kind === "tool-call" && (action.toolName === "bash" || action.toolName === "edit_file"))) {
      return hasPlan;
    }
  }
  return false;
}

/** Смотрим завершение чтения, а не запрос: параллельный read + render не считается просмотром. */
export function framesBeforeFullRender(events: readonly EveEvalStreamEvent[]): boolean {
  const requestedFrames = new Set<string>();
  const completedFrames = new Set<string>();
  for (const event of events) {
    if (event.type === "actions.requested") {
      const actions = event.data.actions.filter((action) => action.kind === "tool-call");
      if (actions.some((action) => action.toolName === "bash" && isFullRender(action.input.command))) {
        return completedFrames.size >= 4;
      }
      for (const action of actions) {
        if (action.toolName === "read_file") requestedFrames.add(action.callId);
      }
    }
    if (event.type === "action.result" && event.data.result.kind === "tool-result" &&
      event.data.status === "completed" && requestedFrames.has(event.data.result.callId)) {
      const output = event.data.result.output;
      if (typeof output !== "object" || output === null || !("path" in output) ||
        typeof output.path !== "string" || !("file" in output) ||
        typeof output.file !== "object" || output.file === null ||
        !("mediaType" in output.file) || typeof output.file.mediaType !== "string" ||
        !output.file.mediaType.startsWith("image/")) continue;
      const path = resolveSandboxFilePath(output.path);
      if (path.kind === "file") completedFrames.add(path.path);
    }
  }
  return false; // Нет полного рендера — нет успеха по одному лишь ffprobe или набору кадров.
}

export function fullRenderCalls(turn: EveEvalTurn): readonly EveEvalToolCall[] {
  return turn.toolCalls.filter((call) => call.name === "bash" && isFullRender(call.input.command));
}

export function encodingResults(calls: readonly EveEvalToolCall[]) {
  const token = process.env.EVE_EVAL_AUTH_TOKEN?.trim();
  if (!token) return [];
  return calls.flatMap((call) => {
    if (call.name !== "bash" || call.status !== "completed" || typeof call.output !== "object" || call.output === null) return [];
    const output = call.output as { stdout?: unknown; stderr?: unknown };
    return videoEvalRenderResults([output.stdout, output.stderr].filter((value) => typeof value === "string").join("\n"), token);
  });
}
