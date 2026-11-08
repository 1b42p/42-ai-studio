import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { EveEvalContext, EveEvalTurn, ToolStub } from "eve/evals";
import { frameOutput, reviewFrames } from "./media-fixture";
import { blockedRead, emptySearch } from "../web/fixtures";

export const TIMEOUT = 20 * 60 * 1000;
export const REQUEST = (seconds: number) => `Сделай ролик про кофе длительностью ${seconds} секунд, ` +
  "16:9, 1920×1080, 30 кадров/с, для взрослых, по-русски, без озвучки и музыки. " +
  "Три сцены: зерно, приготовление, чашка. Материалы не нужны, оформление выбери сам. " +
  "Используй уже созданный проект /workspace/calm-morning с композицией Main; " +
  "Графика и тексты src уже утверждены, сохраняй их, меняй только длительность каждой сцены до трети ролика. " +
  `Контрольные кадры: ${reviewFrames(seconds).join(", ")}; сохраняй их как out/frames-1/element-NNNN.jpeg (NNNN — номер кадра). ` +
  "Готовый файл — out/coffee-v1.mp4. Дополнительных пожеланий нет.";

/** Every effect is stubbed; ask_question alone exercises the real durable input protocol. */
export function questionStubs(seconds = 120): ToolStub[] {
  const bash = (stdout: string) => ({ response: { status: "completed", exitCode: 0, stdout, stderr: "", truncated: false } });
  const read = (path: string, content: string) => ({ response: { path, content, totalLines: content.split("\n").length, truncated: false } });
  const references: ToolStub[] = [];
  function walk(directory: string) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.(md|py)$/.test(entry.name)) {
        const relative = path.slice("agent/skills/".length);
        references.push({ id: `reference-${references.length}`, tool: "read_file",
          match: { filePath: { pattern: `(?:^|/)skills/${relative.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$` } },
          outcome: read(`/root/.agents/skills/${relative}`, readFileSync(path, "utf8")) });
      }
    }
  }
  for (const skill of ["frame-review", "sandbox-environment", "remotion-create", "remotion-markup", "remotion-render"]) walk(`agent/skills/${skill}`);
  const notes = `# Кофе\nФормат 1920×1080, 30 кадров/с, ${seconds} секунд.\n` +
    `| Сцена | Начало | Конец |\n| Зерно | 0 | ${seconds * 10 - 1} |\n` +
    `| Приготовление | ${seconds * 10} | ${seconds * 20 - 1} |\n| Чашка | ${seconds * 20} | ${seconds * 30 - 1} |\n` +
    "Без озвучки и музыки. Проход проверки кадров: 0.\n";
  const root = (corrected = false) => `import React from "react";
import {Composition, useCurrentFrame, useVideoConfig} from "remotion";
import {Coffee} from "./Coffee";
const Main=()=> {const frame=useCurrentFrame();const {durationInFrames}=useVideoConfig();return <Coffee scene={Math.min(2,Math.floor(frame/(durationInFrames/3)))} frame={frame} title=${JSON.stringify(corrected ? "Утро начинается с кофе" : "Кофе начинается с зерна")}/>;};
export const Root=()=> <Composition id="Main" component={Main} durationInFrames={${seconds * 30}} fps={30} width={1920} height={1080}/>;`;
  const coffee = readFileSync("evals/fixtures/questions/Coffee.tsx", "utf8");
  const frames = reviewFrames(seconds);
  const ranges = seconds === 30
    ? ["(?:[0-9]|[1-9][0-9]|[12][0-9]{2})", "[3-5][0-9]{2}", "[6-8][0-9]{2}"]
    : ["(?:[0-9]|[1-9][0-9]|[1-9][0-9]{2}|1[01][0-9]{2})", "(?:1[2-9][0-9]{2}|2[0-3][0-9]{2})", "(?:2[4-9][0-9]{2}|3[0-5][0-9]{2})"];
  const recorded: ToolStub[] = [true, false].flatMap((corrected) => ranges.map((range, scene) => ({
    id: `frame-scene-${scene}-${corrected ? "corrected" : "original"}`, tool: "read_file",
    match: { filePath: { pattern: `${corrected ? "(?:^|/)frames-(?:[2-9]|[1-9][0-9]+)/" : "(?:^|/)"}(?:[^/]*[^/0-9])?0*${range}\\.(?:jpeg|jpg|png)$` } },
    outcome: { response: frameOutput([0, 3, 5][scene], corrected) },
  })));
  const stubs: ToolStub[] = [
    ...references, ...recorded,
    { id: "other-frame", tool: "read_file", match: { filePath: { pattern: "\\.(jpeg|jpg|png)$" } }, outcome: { throw: { message: "Используй записанную выборку кадров и имена element-NNNN.jpeg из задания." } } },
    { id: "notes", tool: "read_file", match: { filePath: { pattern: "NOTES\\.md$" } }, outcome: read("/workspace/calm-morning/NOTES.md", notes) },
    { id: "coffee-source", tool: "read_file", match: { filePath: { pattern: "Coffee\\.tsx$" } }, outcome: read("/workspace/calm-morning/src/Coffee.tsx", coffee) },
    { id: "source", tool: "read_file", match: { filePath: { pattern: "Root\\.tsx$" } },
      outcomes: [read("/workspace/calm-morning/src/Root.tsx", root()), read("/workspace/calm-morning/src/Root.tsx", root(true))] },
    { id: "entry", tool: "read_file", match: { filePath: { pattern: "index\\.ts$" } }, outcome: read("/workspace/calm-morning/src/index.ts", "import {registerRoot} from 'remotion';import {Root} from './Root';registerRoot(Root);") },
    { id: "unknown-source", tool: "read_file", outcome: { throw: { message: "Файл отсутствует; проект содержит src/Root.tsx, src/Coffee.tsx, src/index.ts и NOTES.md." } } },
    { id: "edit", tool: "edit_file", outcome: { response: { path: "/workspace/calm-morning/src/Root.tsx", created: false, replacements: 1, oldContent: "", newContent: "", linesAdded: 1, linesRemoved: 1 } } },
    { id: "metadata-draft", tool: "bash", match: { command: { pattern: "(?:ffprobe|--probe).*(?:draft)" } }, outcome: bash(JSON.stringify({ streams: [{ codec_name: "h264", width: 960, height: 540, r_frame_rate: "30/1", duration: String(seconds), nb_frames: String(seconds * 30) }], format: { duration: String(seconds), size: "1000000" } })) },
    { id: "metadata", tool: "bash", match: { command: { pattern: "ffprobe|--probe" } }, outcome: bash(JSON.stringify({ streams: [{ codec_name: "h264", width: 1920, height: 1080, r_frame_rate: "30/1", duration: String(seconds), nb_frames: String(seconds * 30) }], format: { duration: String(seconds), size: "4000000" } })) },
    { id: "frames-check", tool: "bash", match: { command: { pattern: "check-frames\\.py" } }, outcome: bash(JSON.stringify({ ok: true, frames: frames.map((frame) => ({ path: `/workspace/calm-morning/out/frames-1/element-${String(frame).padStart(4, "0")}.jpeg`, width: 1920, height: 1080, blank: false })) })) },
    { id: "list-frames", tool: "bash", match: { command: { pattern: "(?:find|ls).*frames" } }, outcome: bash(frames.map((frame) => `/workspace/calm-morning/out/frames-1/element-${String(frame).padStart(4, "0")}.jpeg`).join("\n")) },
    { id: "command", tool: "bash", outcome: bash("Готово. Код выхода: 0.") },
    { id: "copy", tool: "agent", outcome: { throw: { message: "Собери ролик основным агентом." } } },
    { id: "speech", tool: "speak", outcome: { throw: { message: "Озвучка не нужна." } } },
    { id: "voices", tool: "list_voices", outcome: { response: { voices: [] } } },
    blockedRead, emptySearch,
  ];
  return stubs;
}

export async function questionSession(t: EveEvalContext, seconds = 120) {
  const stubs = questionStubs(seconds);
  const health = await t.target.fetch("/api/health");
  if (!health.headers.get("x-studio-eval-runtime")) throw new Error("Нужен выделенный eval-сервер.");
  const response = await t.target.fetch("/eve/v1/info");
  if (!response.ok) throw new Error(`Инструменты недоступны: ${response.status}`);
  const info = await response.json() as { tools: { static: { name: string }[]; dynamic: unknown[] } };
  const covered = new Set(stubs.filter((stub) => stub.match === undefined).map((stub) => stub.tool));
  covered.add("ask_question"); // A stub returns JSON immediately and cannot park on human input.
  const uncovered = info.tools.static.filter(({ name }) => !covered.has(name));
  if (uncovered.length || info.tools.dynamic.length) throw new Error(`Неподменённые эффекты: ${uncovered.map(({ name }) => name).join(", ")}`);
  return t.session({ stubs });
}

export function renderCommands(turn: EveEvalTurn) {
  return turn.toolCalls.filter((call) => call.name === "bash").map((call) => (call.input as { command?: string }).command ?? "")
    .filter((command) => /\bremotion\s+render\b/.test(command) && !/--frames(?:=|\s)/.test(command));
}
export const isDraft = (command: string) => /--scale(?:=|\s+)0\.5\b/.test(command);
export const isFinal = (command: string) => !/--scale(?:=|\s)/.test(command);
