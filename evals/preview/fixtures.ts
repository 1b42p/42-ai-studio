import { readFileSync } from "node:fs";
import { posix } from "node:path";
import type { EveEvalContext, ToolStub } from "eve/evals";
import { blockedRead, emptySearch, page, webSession } from "../web/fixtures";
import { esc } from "../music/operation-patterns";
import { atomic, frameName, frameNumbers, framesPattern, nonemptyPattern, pathArg, pixelPattern, probePattern, projectPath, sizePattern, stillPattern, videoPattern } from "./commands";
import { imageOutput, previewFrames } from "./media-fixture";
import integration from "../fixtures/preview/integration.json";

export const TIMEOUT = 20 * 60 * 1000;
const read = (path: string, content: string) => ({ path, content, totalLines: content.split("\n").length, truncated: false });
const completed = (stdout = "") => ({ status: "completed", exitCode: 0, stdout, stderr: "", truncated: false });
export const request = (seconds: number) => [
  `Сделай ролик о спокойном утреннем кофейном ритуале для взрослых, ${seconds} секунд, 16:9, 1920×1080, 30 кадров/с, по-русски, без звука, озвучки и музыки.`,
  `Используй подготовленный проект ${projectPath(seconds)}, композиция Main, параметры props-${seconds}.json. Графика трёх сцен и тексты уже утверждены; исходники и параметры сохраняй.`,
  `Контрольная выборка проекта: ${frameNumbers(seconds).join(", ")}; каталог out/frames-1, имена element-NNNN.jpeg. Это неизменяемый подготовленный проект, операции и доступные файлы описаны в SPEC.md.`,
  "Оставь готовый ролик out/final.mp4. Дополнительных пожеланий нет.",
].join("\n");

const references = ["frame-review/references/notes-template.md", "frame-review/scripts/check-frames.py"];

export function previewStubs(seconds: number): ToolStub[] {
  const P = projectPath(seconds);
  const frames = previewFrames.filter(frame => frame.seconds === seconds && frame.path.includes("/frames-1/"));
  const exports = previewFrames.filter(frame => frame.seconds === seconds && !frame.path.includes("/frames-1/"));
  const bash = (id: string, pattern: string, stdout = ""): ToolStub => ({ id, tool: "bash", match: { command: { pattern } }, outcome: { response: completed(stdout) } });
  const source = readFileSync("evals/fixtures/preview/index.tsx", "utf8");
  const spec = [
    `# Кофейный ритуал\nПроект ${P}; Remotion 4.0.538; 1920×1080, 30 кадров/с, ${seconds} с, Main.`,
    "Три сцены одинаковой длительности: зерно, заваривание, чашка. Исходники src/index.tsx и props неизменяемы. Аудио нет.",
    `Команды рендера используют --props=props-${seconds}.json. Проверочные кадры ${frameNumbers(seconds).join(",")} сохраняются в out/frames-1 с --image-format=jpeg --jpeg-quality=90.`,
    "Полный рендер — out/final.mp4; уменьшенный черновик — out/draft.mp4 с --scale=0.5 --x264-preset=superfast --crf=32. Не склеивай независимые команды в одну shell-строку.",
    "Размер результата проверяется stat -c %s <путь>. Метаданные: npx remotion ffprobe -v error -show_entries stream=codec_name,codec_type,width,height,duration:format=duration -of default=nw=1 <путь>; также доступен полный -show_streams -show_format -of json.",
    "Подготовлены независимые экспорты выразительных кадров (JPEG quality 85, scale 0.5); можно выбрать любой из них. Повторный still с тем же номером кадра и соответствующим путём воспроизводит те же пиксели:",
    ...exports.map(frame => `кадр ${frame.frame}: ${posix.relative(P, frame.path)}`),
    "NOTES.md — write-only журнал: сохраняй полный актуальный снимок без oldString; чтение журнала после записи не поддержано. Неизвестные команды отклоняются без подтверждения успеха.",
  ].join("\n");
  const files = { "src/index.tsx": source, [`props-${seconds}.json`]: JSON.stringify({ seconds }), "SPEC.md": spec,
    "package.json": JSON.stringify({ dependencies: { remotion: "4.0.538", "@remotion/cli": "4.0.538", react: "19.2.3", "react-dom": "19.2.3" } }) };
  const stubs: ToolStub[] = Object.entries(files).map(([path, content]) => ({ id: `file-${path}`, tool: "read_file", match: { filePath: { enum: [`${P}/${path}`, `preview-coffee-${seconds}/${path}`] } }, outcome: { response: read(`${P}/${path}`, content) } }));
  for (const path of references) {
    stubs.push({ id: `reference-${path}`, tool: "read_file", match: { filePath: { pattern: `^(?:\\$HOME|/root)/\\.agents/skills/${esc(path)}$` } }, outcome: { response: read(`/root/.agents/skills/${path}`, readFileSync(`agent/skills/${path}`, "utf8")) } });
  }
  for (const frame of [...frames, ...exports]) {
    const relative = posix.relative(P, frame.path);
    stubs.push({ id: `image-${relative}`, tool: "read_file", match: { filePath: { enum: [frame.path, `preview-coffee-${seconds}/${relative}`] } }, outcome: { response: imageOutput(frame) } });
  }
  stubs.push(bash("frames-render", framesPattern(seconds), frames.map(frame => `Rendered ${frame.path}`).join("\n")));
  const pixels = (selection: typeof frames) => selection.map(frame => JSON.stringify({ path: frame.path, extrema: "extrema" in frame ? frame.extrema : null, suspect: null })).join("\n");
  stubs.push(bash("pixels-all", pixelPattern(frames.map(frame => posix.relative(P, frame.path)), seconds, true), pixels(frames)));
  for (const frame of frames) stubs.push(bash(`pixels-${frame.frame}`, pixelPattern([posix.relative(P, frame.path)], seconds), pixels([frame])));
  const videos = integration.videos.filter(video => video.seconds === seconds);
  if (videos.length !== 2 || new Set(videos.map(video => video.draft)).size !== 2) {
    throw new Error(`Для ${seconds} секунд нужны записанные финал и черновик вместе с размером и метаданными.`);
  }
  for (const video of videos) {
    const mode = video.draft ? "draft" : "final";
    stubs.push(bash(`${mode}-render`, videoPattern(seconds, video.draft), `Rendered ${video.path}`));
    stubs.push(bash(`video-probe-${mode}`, probePattern(seconds, video.draft), JSON.stringify(video.probe)));
    const selected = video.probe.streams.flatMap(stream => [
      `codec_name=${stream.codec_name}`, `codec_type=${stream.codec_type}`,
      `width=${stream.width}`, `height=${stream.height}`, `duration=${stream.duration}`,
    ]);
    stubs.push(bash(`video-probe-selected-${mode}`, probePattern(seconds, video.draft, "selected-default"), [...selected, `duration=${video.probe.format.duration}`, ""].join("\n")));
    stubs.push(bash(`video-size-${mode}`, sizePattern(seconds, video.draft), `${video.size}\n`));
    stubs.push(bash(`video-nonempty-${mode}`, nonemptyPattern(seconds, video.draft)));
  }
  for (const frame of exports) {
    const relative = posix.relative(P, frame.path);
    stubs.push(bash(`still-${frame.frame}`, stillPattern(seconds, frame.frame, relative), `Rendered ${frame.path}`));
  }
  for (const frame of [...frames, ...exports]) {
    stubs.push({ id: `publish-${posix.basename(frame.path)}`, tool: "set_session_preview", match: { path: { enum: [frame.path, `preview-coffee-${seconds}/${posix.relative(P, frame.path)}`] } }, outcome: { response: { path: frame.path, size: frame.size, contentType: "image/jpeg" } } });
  }
  stubs.push({ id: "preview-catchall", tool: "set_session_preview", outcome: { throw: { message: "preview_not_found: Этот путь не записан в подготовленном проекте. Доступные JPEG и номера кадров перечислены в SPEC.md; выбери любой из них." } } });
  stubs.push(bash("pwd", atomic("pwd", seconds), `${P}\n`));
  stubs.push(bash("list-frames", atomic(`ls\\s+${pathArg("out/frames-1", seconds)}`, seconds), frames.map(frame => frameName(frame.frame)).join("\n")));
  stubs.push(bash("mkdir-out", atomic(`mkdir\\s+-p\\s+${pathArg("out", seconds)}`, seconds)));
  stubs.push({ id: "notes-replacement", tool: "edit_file", match: { filePath: { enum: [`${P}/NOTES.md`, `preview-coffee-${seconds}/NOTES.md`] }, oldString: { minLength: 1 } }, outcome: { throw: { message: "Журнал принимает только полный снимок, без oldString." } } });
  stubs.push({ id: "notes-write", tool: "edit_file", match: { filePath: { enum: [`${P}/NOTES.md`, `preview-coffee-${seconds}/NOTES.md`] } }, outcome: { response: { path: `${P}/NOTES.md`, created: true, replacements: 0, linesAdded: 1, linesRemoved: 0 } } });
  stubs.push({ id: "immutable-source", tool: "edit_file", outcome: { throw: { message: "Исходники утверждены и неизменяемы; новый код не имеет записанных кадров. Разрешён полный снимок NOTES.md." } } });
  stubs.push({ id: "unknown-read", tool: "read_file", outcome: { throw: { message: "Чтение не записано. SPEC.md и src/index.tsx доступны по полному пути; отказ не означает потерю файла или записи NOTES.md." } } });
  stubs.push({ id: "unsupported-command", tool: "bash", outcome: { throw: { message: "Команда не записана в контракте проекта; успех не подтверждён. Поддержаны отдельные render, still, check-frames.py и ls out/frames-1. SPEC.md содержит пути и контрольную выборку. Составные команды и изменения исходников не исполнялись." } } });
  stubs.push({ id: "remotion-still-docs", tool: "read_page", match: { url: { pattern: "^https://www\\.remotion\\.dev/docs/cli/still(?:\\.md)?/?$" } }, outcome: { response: page("https://www.remotion.dev/docs/cli/still", "remotion still", "npx remotion still <entry> <composition> <output> --frame=<number> --image-format=jpeg --jpeg-quality=85 --scale=0.5. --props accepts a JSON file.", "en") } });
  stubs.push(blockedRead, emptySearch);
  return stubs;
}

export async function previewSession(t: EveEvalContext, seconds: number) {
  const health = await t.target.fetch("/api/health");
  if (!health.headers.get("x-studio-eval-runtime")) throw new Error("Оценкам превью нужен APP_STUB_EVAL_SANDBOX=1 на выделенном сервере.");
  return webSession(t, previewStubs(seconds));
}
