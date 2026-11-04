import { posix } from "node:path";
import type { EveEvalStreamEvent, EveEvalToolCall, EveEvalTurn } from "eve/evals";

// Ограничиваем --frames текущей shell-командой: следующий render может быть полным.
// ffprobe и still сюда не попадают. Один pattern используется и в stubs, и в проверках.
export const FULL_RENDER_PATTERN = String.raw`\bremotion["']?\s+["']?render\b(?![^;&|\n]*--frames(?:=|\s|["']|$))`;

export function isFullRender(command: unknown): boolean {
  return typeof command === "string" && new RegExp(FULL_RENDER_PATTERN).test(command);
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

export function workspacePath(path: string, cwd = "/workspace"): string | undefined {
  if (/^[a-z][a-z\d+.-]*:/iu.test(path) || /[\\\u0000-\u001f]/u.test(path)) return undefined;
  const absolute = posix.resolve(cwd, path);
  return absolute.startsWith("/workspace/") ? absolute : undefined;
}

/** Путь ссылки нормализуется от /workspace, как в приложении, а не от cwd bash. */
export function videoLinks(message: string | undefined): string[] {
  const links: string[] = [];
  for (const match of (message ?? "").matchAll(/!?\[[^\]\n]*\]\(\s*(?:<([^>\n]+)>|([^\s)]+))(?:\s+["'][^\n]*?["'])?\s*\)/g)) {
    if (match[0].startsWith("!")) continue;
    try {
      const path = workspacePath(decodeURIComponent((match[1] ?? match[2]).split(/[?#]/, 1)[0]));
      if (path && /\.mp4$/iu.test(path)) links.push(path);
    } catch { /* Неверное процентное кодирование не превращается в файл. */ }
  }
  return links;
}

/** У bash каждый вызов начинается в /workspace; cd действует внутри одной команды. */
export function renderOutputs(calls: readonly EveEvalToolCall[]): string[] {
  const outputs: string[] = [];
  for (const call of calls) {
    if (call.name !== "bash" || typeof call.input.command !== "string") continue;
    let cwd = "/workspace";
    for (const argv of commands(call.input.command)) {
      const cd = argv.indexOf("cd");
      if (cd >= 0 && argv[cd + 1]) cwd = posix.resolve(cwd, argv[cd + 1]);
      const remotion = argv.findIndex((word) => posix.basename(word) === "remotion");
      if (remotion < 0 || argv[remotion + 1] !== "render" ||
        argv.some((word) => word === "--frames" || word.startsWith("--frames="))) continue;
      for (const word of argv.slice(remotion + 2)) {
        if (word.startsWith("-") || !/\.mp4$/iu.test(word)) continue;
        const path = workspacePath(word, cwd);
        if (path) outputs.push(path);
      }
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
        return completedFrames.size >= 3;
      }
      for (const action of actions) {
        if (action.toolName === "read_file" && isFramePath(action.input.filePath)) requestedFrames.add(action.callId);
      }
    }
    if (event.type === "action.result" && event.data.result.kind === "tool-result" &&
      event.data.status === "completed" && requestedFrames.has(event.data.result.callId)) {
      completedFrames.add(event.data.result.callId);
    }
  }
  return false; // Нет полного рендера — нет успеха по одному лишь ffprobe или набору кадров.
}

export function fullRenderCalls(turn: EveEvalTurn): readonly EveEvalToolCall[] {
  return turn.toolCalls.filter((call) => call.name === "bash" && isFullRender(call.input.command));
}
