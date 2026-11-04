import type { EveEvalContext, ToolStub } from "eve/evals";
import { blockedRead, emptySearch } from "../web/fixtures";
import { FULL_RENDER_PATTERN } from "./observations";

export const VIDEO_REQUEST = "Сделай 30-секундный вертикальный ролик 9:16 о пользе утренней зарядки, без озвучки, три сцены.";

const PROJECT = "/workspace/morning-exercise";
// Текстовые фикстуры: не обещают изображение в file и не запускают публикацию в S3.
const FRAME_DESCRIPTION = "Кадр 1080×1920. Русский текст читается на контрастном фоне, " +
  "не обрезан, отступы достаточные. Элементы не перекрываются, букв-заглушек и потерянных эмодзи нет. " +
  "Изображения исправны; кадр не пустой и не чёрный. Конечное состояние сцены соответствует замыслу.";

const NOTES = `# Утренняя зарядка
Формат: 9:16, 1080×1920, 30 к/с, длительность 30 с
Последний рендер: out/morning-exercise.mp4
## Сцены
| № | Текст | Кадр начала | Кадр конца |
| --- | --- | --- | --- |
| 1 | Проснись и потянись | 0 | 299 |
| 2 | Мягко разомни суставы | 300 | 599 |
| 3 | Начни день с движения | 600 | 899 |`;

const SOURCE = `import {AbsoluteFill, Sequence} from 'remotion';
export const Main = () => <AbsoluteFill style={{backgroundColor: '#142b24', color: 'white', fontSize: 84, padding: 100}}>
  <Sequence durationInFrames={300}><AbsoluteFill>Проснись и потянись</AbsoluteFill></Sequence>
  <Sequence from={300} durationInFrames={300}><AbsoluteFill>Мягко разомни суставы</AbsoluteFill></Sequence>
  <Sequence from={600} durationInFrames={300}><AbsoluteFill>Начни день с движения</AbsoluteFill></Sequence>
</AbsoluteFill>;`;

function bash(stdout = "", exitCode = 0, stderr = "") {
  return { status: "completed", exitCode, stdout, stderr, truncated: false };
}

function text(path: string, content: string) {
  return { path, content, totalLines: content.split("\n").length, truncated: false };
}

/** Список — зафиксированный набор кадров трёх сцен, а не выдуманный element-0.jpeg. */
const FRAME_LIST = [0, 75, 255, 375, 555, 675, 855, 899]
  .map((frame) => `element-${String(frame).padStart(3, "0")}.jpeg`).join("\n");

function videoStubs(renderFails: boolean): readonly ToolStub[] {
  return [
    // Первое подходящее правило побеждает, поэтому сбой выше ls/ffprobe и fallback.
    ...(renderFails ? [{
      id: "fail-full-render", tool: "bash", match: { command: { pattern: FULL_RENDER_PATTERN } },
      outcome: { response: bash("", 1, "Error: render failed while encoding the composition; MP4 was not created.") },
    } satisfies ToolStub] : []),
    {
      id: "list-frames", tool: "bash",
      match: { command: { pattern: String.raw`(?:\bls\b[^;&|\n]*(?:frames(?:-[\w-]+)?(?:/|["']|\s|$)|\.(?:jpeg|png)|\*)|\bcd\b[^;&|\n]*frames[^;&|\n]*[;&|]+\s*ls\b)` } },
      outcome: { response: bash(FRAME_LIST) },
    },
    {
      id: "probe-video", tool: "bash", match: { command: { pattern: String.raw`\bffprobe\b` } },
      outcome: { response: renderFails
        ? bash("", 1, "No such file: MP4 was not created because rendering failed.")
        : bash("codec_name=h264\nwidth=1080\nheight=1920\nduration=30.000000\n") },
    },
    {
      id: "sandbox-cpu", tool: "bash", match: { command: { pattern: String.raw`\bsandbox-vcpu\b` } },
      outcome: { response: bash("2\n") },
    },
    { id: "isolate-bash", tool: "bash", outcome: { response: bash() } },
    {
      id: "read-frame", tool: "read_file", match: { filePath: { pattern: String.raw`\.(?:jpeg|jpg|png)$` } },
      outcome: { response: text(`${PROJECT}/out/frames/element-000.jpeg`, FRAME_DESCRIPTION) },
    },
    {
      id: "read-notes", tool: "read_file", match: { filePath: { pattern: String.raw`(?:^|/)NOTES\.md$` } },
      outcome: { response: text(`${PROJECT}/NOTES.md`, NOTES) },
    },
    {
      id: "read-source", tool: "read_file", match: { filePath: { pattern: String.raw`\.(?:tsx|jsx)$` } },
      outcome: { response: text(`${PROJECT}/src/Main.tsx`, SOURCE) },
    },
    {
      id: "isolate-read-file", tool: "read_file",
      outcome: { response: text(`${PROJECT}/package.json`, '{"scripts":{"render":"remotion render src/index.ts Main"},"dependencies":{"remotion":"4.0.538","react":"19"}}') },
    },
    {
      id: "isolate-edit-file", tool: "edit_file",
      outcome: { response: { path: `${PROJECT}/src/Main.tsx`, created: false, replacements: 1,
        oldContent: "", newContent: "", linesAdded: 0, linesRemoved: 0 } },
    },
    // Persistent-инструмент требует безусловной подмены, иначе может стартовать копия.
    { id: "isolate-agent", tool: "agent", outcome: { throw: { message: "Этот короткий ролик собери основным агентом; делегирование в оценке отключено." } } },
    {
      id: "isolate-speak", tool: "speak",
      outcome: { response: { audioPath: `${PROJECT}/voiceover/stub.mp3`, timingsPath: `${PROJECT}/voiceover/stub.words.json`,
        voice: "ru-RU-SvetlanaNeural", language: "ru-RU", format: "mp3", durationMs: 1000,
        wordCount: 1, text: "Подмена", media: { audioId: "00000000-0000-4000-8000-000000000001" } } },
    },
    { id: "isolate-voices", tool: "list_voices", outcome: { response: { voices: [] } } },
    blockedRead, emptySearch,
  ];
}

/** Все static tools покрыты безусловно; новые инструменты и dynamic resolvers запрещены. */
export async function videoSession(t: EveEvalContext, { renderFails = false } = {}) {
  const stubs = videoStubs(renderFails);
  const response = await t.target.fetch("/eve/v1/info");
  if (!response.ok) throw new Error(`Не удалось получить инструменты для изоляции: ${response.status}`);
  const info = await response.json() as { tools?: { static?: { name: string }[]; dynamic?: unknown[] } };
  const tools = info.tools?.static;
  if (!Array.isArray(tools) || !Array.isArray(info.tools?.dynamic) ||
    !["bash", "read_file", "edit_file"].every((name) => tools.some((tool) => tool.name === name))) {
    throw new Error("Не удалось проверить инструменты целевого агента.");
  }
  const covered = new Set(stubs.filter((stub) => stub.match === undefined).map((stub) => stub.tool));
  const uncovered = tools.filter(({ name }) => !covered.has(name));
  if (uncovered.length > 0 || info.tools.dynamic.length > 0) {
    throw new Error(`Не все инструменты изолированы подменами: ${uncovered.map(({ name }) => name).join(", ")}; dynamic: ${info.tools.dynamic.length}`);
  }
  // eve__skill не подменяется: инструкции загружаются из настоящих навыков агента.
  return t.session({ stubs });
}
