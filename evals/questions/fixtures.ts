import { readFileSync } from "node:fs";
import { posix } from "node:path";
import type { EveEvalContext, EveEvalTurn, ToolStub } from "eve/evals";
import {
  frameDirectory, frameName, frameOutput, framePasses, questionFramesFor, questionProjectPath,
  questionProps, questionSnapshot, questionSources, reviewFrames, type PropsVersion,
} from "./media-fixture";
import { esc, entriesPattern, optionOrders, pixelInvocation, quote } from "../music/operation-patterns";
import { blockedRead, emptySearch, isolateDownload } from "../web/fixtures";

export const TIMEOUT = 20 * 60 * 1000;
export const REQUEST = (seconds: number) => `Сделай ролик про кофе длительностью ${seconds} секунд, ` +
  "16:9, 1920×1080, 30 кадров/с, для взрослых, по-русски, без озвучки и музыки. " +
  "Три сцены: зерно, приготовление, чашка. Материалы не нужны, оформление выбери сам. " +
  `Используй уже созданный проект ${questionProjectPath(seconds)} с композицией Main; ` +
  "Графика src и тексты уже утверждены, сохраняй их; длительность каждой сцены — треть ролика. " +
  "Текст заголовка передаётся через props-v1.json: используй --props=props-v1.json при рендере кадров и видео. " +
  "Поддерживаемые операции, подстановка props-v2.json и происхождение записанных изображений описаны в SPEC.md; Root.tsx и Coffee.tsx неизменяемы. " +
  `Контрольные кадры ${reviewFrames(seconds).join(", ")}; исходная выборка out/props-v1/frames-1, имена ${frameName(seconds, 0)} … ${frameName(seconds, seconds * 30 - 1)} (число — абсолютный номер кадра). ` +
  "Каталоги изображений содержат версию props, а номер прохода сам по себе её не меняет. Результаты сохраняй в out/. Дополнительных пожеланий нет.";

const skillRoot = "(?:\\$HOME/|/root/|/{1,2})\\.agents/skills";
const cli = "(?:npx\\s+)?remotion\\s+";
const completed = (stdout = "") => ({ status: "completed", exitCode: 0, stdout, stderr: "", truncated: false });
const read = (path: string, content: string) => ({ path, content, totalLines: content.split("\n").length, truncated: false });

/** A bounded command grammar, not shell execution or a mutable filesystem. */
function options(required: string[], optional: string[] = []) {
  const flags = [...required, ...optional];
  const present = required.map(flag => `(?=(?:[^\\r\\n]*\\s)?${flag}(?:\\s|$))`).join("");
  const unique = flags.map(flag => flag.match(/^--[a-z0-9-]+/)![0])
    .map(name => `(?![^\\r\\n]*${name}(?:=|\\s)[^\\r\\n]*${name}(?:=|\\s))`).join("");
  return `${present}${unique}(?:${flags.join("|")})(?:\\s+(?:${flags.join("|")}))*`;
}

function commandSyntax(seconds: number) {
  const P = questionProjectPath(seconds);
  return {
    pathArg: (path: string) => quote(`(?:${esc(P)}/)?${esc(path)}`),
    atomic: (body: string) => `^(?![\\s\\S]*[\\r\\n])[ \\t]*(?:cd[ \\t]+${quote(esc(P))}[ \\t]*&&[ \\t]*)?${body}[ \\t]*$`,
  };
}

/** Canonical nominal MP4 capabilities, shared by playback and causal assertions. */
export function questionVideoContracts(seconds: number) {
  reviewFrames(seconds);
  const { pathArg, atomic } = commandSyntax(seconds);
  const runtime = ["--codec(?:=|\\s+)h264", "--concurrency(?:=|\\s+)[12]", "--log(?:=|\\s+)error", "--overwrite"];
  return ([1, 2] as PropsVersion[]).flatMap(version => [false, true].map(draft => {
    const relativePath = `out/coffee-v${version}${draft ? "-draft" : ""}.mp4`;
    const path = `${questionProjectPath(seconds)}/${relativePath}`;
    const sizeBytes = draft ? 1_000_000 : 4_000_000;
    const width = draft ? 960 : 1920;
    const height = draft ? 540 : 1080;
    const metadata = { streams: [{ codec_name: "h264", codec_type: "video", width, height,
      r_frame_rate: "30/1", duration: String(seconds), nb_frames: String(seconds * 30) }],
      format: { filename: relativePath, duration: String(seconds), size: String(sizeBytes) } };
    const probeFields = `codec_name=h264\ncodec_type=video\nwidth=${width}\nheight=${height}\nduration=${seconds}\nduration=${seconds}\n`;
    const renderPattern = atomic(`${cli}render\\s+${pathArg("src/index.ts")}\\s+Main\\s+${pathArg(relativePath)}\\s+${options([
      `--props(?:=|\\s+)${pathArg(`props-v${version}.json`)}`,
      ...(draft ? ["--scale(?:=|\\s+)0\\.5", "--x264-preset(?:=|\\s+)superfast", "--crf(?:=|\\s+)32"] : []),
    ], [...runtime, "--muted", ...(!draft ? [
      "--crf(?:=|\\s+)(?:[0-4]?[0-9]|5[01])",
      "--x264-preset(?:=|\\s+)(?:ultrafast|superfast|veryfast|faster|fast|medium|slow|slower|veryslow|placebo)",
      "--scale(?:=|\\s+)1(?:\\.0)?",
    ] : [])])}`);
    const probePattern = atomic(`${cli}ffprobe\\s+${optionOrders([
      "-(?:v|loglevel)\\s+error", "-show_streams", "-show_format", `-(?:of|print_format)\\s+${quote("json")}`,
    ])}\\s+${pathArg(relativePath)}`);
    const probeFieldsPattern = atomic(`${cli}ffprobe\\s+${optionOrders([
      "-(?:v|loglevel)\\s+error", `-show_entries\\s+${entriesPattern("stream=codec_name,codec_type,width,height,duration:format=duration")}`,
      `-(?:of|print_format)\\s+${quote("default=(?:nw|noprint_wrappers)=1")}`,
    ])}\\s+${pathArg(relativePath)}`);
    const sizePattern = atomic(`stat\\s+-c\\s*${quote("%s")}\\s+${pathArg(relativePath)}`);
    const nonemptyPattern = atomic(`test\\s+-s\\s+${pathArg(relativePath)}`);
    const previewRelativePath = `out/preview-v${version}.jpg`;
    const previewPath = `${questionProjectPath(seconds)}/${previewRelativePath}`;
    const stillPattern = atomic(`${cli}still\\s+${pathArg("src/index.ts")}\\s+Main\\s+${pathArg(previewRelativePath)}\\s+${options([
      `--props(?:=|\\s+)${pathArg(`props-v${version}.json`)}`,
      `--frame(?:=|\\s+)(?:${reviewFrames(seconds).join("|")})`,
      "--image-format(?:=|\\s+)jpeg", "--jpeg-quality(?:=|\\s+)85", "--scale(?:=|\\s+)0\\.5",
    ])}`);
    return {
      seconds, version, draft, path, relativePath, width, height, sizeBytes, metadata, probeFields,
      renderPattern, probePattern, probeFieldsPattern,
      sizePattern, nonemptyPattern,
      render: new RegExp(renderPattern),
      size: new RegExp(sizePattern),
      nonempty: new RegExp(nonemptyPattern),
      probe: new RegExp(`(?:${probePattern}|${probeFieldsPattern})`),
      previewPath, previewRelativePath, previewSizeBytes: 65536,
      stillPattern, stillRegExp: new RegExp(stillPattern),
    };
  }));
}

export type QuestionVideoContract = ReturnType<typeof questionVideoContracts>[number];
export type QuestionVideoOperation = "render" | "size" | "nonempty" | "probe" | "probeFields";

/** Recognition proves the command's identity, not that it ran or succeeded. */
export function questionVideoCommand(seconds: number, command: unknown): {
  video: QuestionVideoContract;
  operation: QuestionVideoOperation;
} | null {
  if (typeof command !== "string") return null;
  for (const video of questionVideoContracts(seconds)) {
    for (const operation of ["render", "size", "nonempty", "probe", "probeFields"] as const) {
      if (new RegExp(video[`${operation}Pattern`]).test(command)) return { video, operation };
    }
  }
  return null;
}

/** Every effect is stubbed; ask_question alone exercises the real durable input protocol. */
export function questionStubs(seconds = 120): ToolStub[] {
  const P = questionProjectPath(seconds);
  const { pathArg, atomic } = commandSyntax(seconds);
  const paths = (path: string) => [`${P}/${path}`, `calm-morning-${seconds}/${path}`];
  const bash = (id: string, body: string, stdout = ""): ToolStub => ({
    id, tool: "bash", match: { command: { pattern: atomic(body) } }, outcome: { response: completed(stdout) },
  });
  const references = [
    "frame-review/references/notes-template.md", "frame-review/scripts/check-frames.py",
    "remotion-create/video-layout.md", "remotion-markup/compositions.md", "remotion-markup/multi-scene-video.md",
    "remotion-interactivity/timeline-structure.md",
  ];
  const stubs: ToolStub[] = references.map(relative => ({
    id: `reference-${relative}`, tool: "read_file",
    match: { filePath: { pattern: `^${skillRoot}/${esc(relative)}$` } },
    outcome: { response: read(`/root/.agents/skills/${relative}`, readFileSync(`agent/skills/${relative}`, "utf8")) },
  }));
  const notes = `# Кофе\nФормат 1920×1080, 30 кадров/с, ${seconds} секунд.\n` +
    `| Сцена | Начало | Конец |\n| Зерно | 0 | ${seconds * 10 - 1} |\n` +
    `| Приготовление | ${seconds * 10} | ${seconds * 20 - 1} |\n| Чашка | ${seconds * 20} | ${seconds * 30 - 1} |\n` +
    "Без озвучки и музыки. Исходные тексты передаются через props-v1.json.\n";
  const batches = ([1, 2] as PropsVersion[]).flatMap(version => framePasses(version).map(pass => ({
    version, pass, directory: frameDirectory(version, pass), frames: questionFramesFor(seconds, version, pass),
  })));
  const spec = [
    `# Кофе\nПроект ${P}; Main, src/index.ts; ${seconds} секунд, 30 кадров/с, 1920×1080.`,
    "src/Root.tsx, src/Coffee.tsx и src/index.ts неизменяемы. Начальные параметры — props-v1.json.",
    ...([1, 2] as PropsVersion[]).map(version => {
      const snapshot = questionSnapshot(seconds, version);
      return `Снимок v${version}: source SHA-256 ${snapshot.sourceSha256}, props SHA-256 ${snapshot.propsSha256}, fingerprint ${snapshot.fingerprint}. JSON: ${questionProps(version)}`;
    }),
    "JPEG записаны ReactDOMServer.renderToStaticMarkup(Coffee) и Chromium, отдельно для каждого фактического номера кадра, длительности и JSON. Это неизменяемые записанные возможности, не изменяемая файловая система и не доказательство просмотра в текущем запуске.",
    ...batches.map(batch => `${batch.directory}: props-v${batch.version}.json; ${batch.frames.map(frame => posix.basename(frame.path)).join(", ")}. Повторный проход v1 сохраняет исходные пиксели и исходный заголовок.`),
    `Все команды проекта выполняются из ${P}; допускается отдельный префикс cd ${P} &&. Не объединяй независимые операции shell-цепочками.`,
    `Изображения: npx remotion render src/index.ts Main <каталог из списка> --props=props-v<версия>.json --frames=${reviewFrames(seconds).join(",")} --image-format=jpeg --jpeg-quality=90. Другая выборка и извлечение ffmpeg не записаны. Имена element-<номер>.jpeg — абсолютные номера, а не порядковые номера извлечения.`,
    'Пиксели всей выборки: python3 "$HOME/.agents/skills/frame-review/scripts/check-frames.py" <каталог>/*.jpeg либо полный упорядоченный список восьми файлов. Затем файлы доступны read_file по полным путям.',
    "Выходы видео для props-v1.json: out/coffee-v1.mp4, out/coffee-v1-draft.mp4; для props-v2.json: out/coffee-v2.mp4, out/coffee-v2-draft.mp4. Команда npx remotion render src/index.ts Main <выход> --props=<соответствующий JSON>; для *-draft.mp4 обязательны --scale=0.5 --x264-preset=superfast --crf=32. Необязательные флаги: --codec=h264, --concurrency=1 или 2, --log=error, --overwrite, --muted. Для полного размера также допустимы --scale=1, --crf=0…51 и документированные --x264-preset.",
    "Видеоэффекты полностью подменены: завершение render, размер и probe — номинальные ответы, не реальное создание или измерение MP4. Размер: stat -c %s <известный MP4>; ненулевой файл: test -s <известный MP4>. Метаданные: npx remotion ffprobe -v error -show_streams -show_format -of json <известный MP4>; также поддержан -show_entries stream=codec_name,codec_type,width,height,duration:format=duration -of default=nw=1.",
    `Номинальная возможность still: npx remotion still src/index.ts Main out/preview-v<версия>.jpg --props=props-v<та же версия>.json --frame=<один из ${reviewFrames(seconds).join(",")}> --image-format=jpeg --jpeg-quality=85 --scale=0.5. Поддержаны только версии 1 и 2. set_session_preview принимает соответствующий полный путь ${P}/out/preview-v1.jpg или ${P}/out/preview-v2.jpg (также путь от /workspace/). Оба вызова полностью подменены: JPEG и объект S3 не создаются; размер 65536 в ответе публикации номинальный. Пиксели preview-v1.jpg и preview-v2.jpg не записаны: read_file этих путей не поддержан и не подменяется контрольным кадром.`,
    `edit_file принимает единственную записанную подстановку props-v2.json: полный newString ${questionProps(2)} без oldString. Чтение props-v2.json возвращает этот неизменяемый образец, не подтверждение предшествующей записи. Другие тексты, версии и правки src не поддержаны.`,
    "NOTES.md возвращает только первый исходный снимок; повторное чтение отклоняется, чтобы старые заметки не выдавались за новые. edit_file принимает полный снимок NOTES.md с overwrite: true без oldString, не моделируя последующее чтение. Сохраняй актуальные заметки в контексте.",
    "Доступны pwd, test -d node_modules, test -s неизменяемого файла, mkdir -p известного выходного каталога; ls для известных каталогов, ls -l и ls -la для корня и src, ls -l package.json показывают исходный манифест, не состояние записей. Неизвестные команды, пути и параметры отклоняются без частичного исполнения.",
    `Навыки загружаются штатным каталогом eve. read_file поддерживает вложенные справочные файлы: ${references.join(", ")}; пути $HOME/.agents/skills/, /.agents/skills/ и /root/.agents/skills/.`,
  ].join("\n");
  const files: Record<string, string> = {
    ...questionSources(seconds),
    "props-v1.json": questionProps(1), "props-v2.json": questionProps(2), "SPEC.md": spec,
    "package.json": JSON.stringify({ dependencies: { remotion: "4.0.538", react: "19.3.1", "react-dom": "19.3.1", "@remotion/cli": "4.0.538" } }),
    "remotion.config.ts": "import {Config} from '@remotion/cli/config';Config.setVideoImageFormat('jpeg');Config.setOverwriteOutput(true);",
    "tsconfig.json": JSON.stringify({ compilerOptions: { jsx: "react-jsx", esModuleInterop: true } }),
  };
  for (const [path, content] of Object.entries(files)) stubs.push({
    id: `file-${path}`, tool: "read_file", match: { filePath: { enum: paths(path) } }, outcome: { response: read(`${P}/${path}`, content) },
  });
  for (const batch of batches) {
    for (const frame of batch.frames) stubs.push({
      id: `frame-v${batch.version}-${batch.pass}-${frame.frame}`, tool: "read_file",
      match: { filePath: { enum: paths(posix.relative(P, frame.path)) } }, outcome: { response: frameOutput(frame) },
    });
    const props = `--props(?:=|\\s+)${pathArg(`props-v${batch.version}.json`)}`;
    stubs.push(bash(`frames-v${batch.version}-${batch.pass}`,
      `${cli}render\\s+${pathArg("src/index.ts")}\\s+Main\\s+${pathArg(batch.directory)}\\s+${options([
        props, `--frames(?:=|\\s+)${reviewFrames(seconds).join(",")}`, "--image-format(?:=|\\s+)jpeg", "--jpeg-quality(?:=|\\s+)90",
      ], ["--concurrency(?:=|\\s+)[12]", "--log(?:=|\\s+)error", "--overwrite"])}`,
      batch.frames.map(frame => `Recorded ${frame.path}`).join("\n")));
    const inputs = batch.frames.map(frame => pathArg(posix.relative(P, frame.path))).join("\\s+");
    const report = batch.frames.map(({ path, extrema }) => JSON.stringify({ path, extrema, suspect: null })).join("\n") +
      "\nПустые кадры не обнаружены. Теперь обязателен визуальный просмотр всех выбранных кадров через read_file.";
    stubs.push(bash(`pixels-v${batch.version}-${batch.pass}`,
      `${pixelInvocation}\\s+(?:${inputs}|${pathArg(batch.directory)}/\\*\\.jpeg)`, report));
  }

  const videos = questionVideoContracts(seconds);
  for (const video of videos) {
    const suffix = `v${video.version}-${video.draft ? "small" : "full"}`;
    for (const [operation, stdout] of [
      ["render", `Номинальная подмена render: ${video.path}`], ["size", `${video.sizeBytes}\n`],
      ["nonempty", ""], ["probe", JSON.stringify(video.metadata)], ["probeFields", video.probeFields],
    ] as const) stubs.push({
      id: `${operation}-${suffix}`, tool: "bash", match: { command: { pattern: video[`${operation}Pattern`] } },
      outcome: { response: completed(stdout) },
    });
    if (!video.draft) stubs.push(
      { id: `still-v${video.version}`, tool: "bash", match: { command: { pattern: video.stillPattern } },
        outcome: { response: completed(`Номинальная подмена still: ${video.previewPath}. JPEG не создавался; пиксели не записаны.`) } },
      { id: `publish-preview-v${video.version}`, tool: "set_session_preview",
        match: { path: { enum: paths(video.previewRelativePath) } },
        outcome: { response: { path: video.previewPath, size: video.previewSizeBytes, contentType: "image/jpeg" } } },
    );
  }
  const sizes = Object.fromEntries([
    ...Object.entries(files).map(([path, content]) => [path, Buffer.byteLength(content)] as const),
    ...batches.flatMap(batch => batch.frames.map(frame => [posix.relative(P, frame.path), frame.size] as const)),
    ...videos.map(video => [video.relativePath, video.sizeBytes] as const),
  ]);
  const directories: Record<string, string[]> = { "": [...Object.keys(files).filter(path => !path.includes("/")), "NOTES.md", "node_modules", "out", "src"] };
  for (const path of [...Object.keys(sizes), "NOTES.md"]) {
    let directory = posix.dirname(path);
    while (directory !== ".") {
      directories[directory] ??= [];
      const name = path.slice(directory.length + 1).split("/")[0];
      if (!directories[directory].includes(name)) directories[directory].push(name);
      directory = posix.dirname(directory);
    }
  }
  const longLine = (name: string, path: string) => `${Object.hasOwn(sizes, path) || path === "NOTES.md" ? "-rw-r--r--" : "drwxr-xr-x"} 1 fixture fixture ${sizes[path] ?? (path === "NOTES.md" ? Buffer.byteLength(notes) : 0)} Jan 1 00:00 ${name}`;
  for (const [directory, entries] of Object.entries(directories)) {
    const names = [...entries].sort();
    const target = directory ? `\\s+${pathArg(directory)}` : `(?:\\s+${quote(`(?:${esc(P)}/?|\\.)`)})?`;
    stubs.push(bash(`ls-${directory || "root"}`, `ls${target}`, names.join("\n") + "\n"));
    if (directory === "" || directory === "src") {
      const rows = names.map(name => longLine(name, directory ? `${directory}/${name}` : name));
      stubs.push(bash(`ls-long-${directory || "root"}`, `ls\\s+-(?:l|la|al)${target}`, rows.join("\n") + "\n"));
    }
  }
  // Exact paths only; a listing is a fixed manifest, never evidence of a new write.
  stubs.push(bash("ls-file-package", `ls\\s+-l\\s+${pathArg("package.json")}`, longLine("package.json", "package.json") + "\n"));
  stubs.push(bash("pwd", "pwd", `${P}\n`));
  const immutablePaths = [...Object.keys(files), ...batches.flatMap(batch => batch.frames.map(frame => posix.relative(P, frame.path)))];
  stubs.push(bash("known-file-test", `test\\s+-s\\s+(?:${immutablePaths.map(pathArg).join("|")})`));
  stubs.push(bash("node-modules", `test\\s+-d\\s+${pathArg("node_modules")}`));
  stubs.push(bash("mkdir-output", `mkdir\\s+-p\\s+(?:${Object.keys(directories).filter(path => path === "out" || path.startsWith("out/")).map(pathArg).join("|")})`));
  stubs.push(
    { id: "notes", tool: "read_file", match: { filePath: { enum: paths("NOTES.md") } }, outcomes: [
      { response: read(`${P}/NOTES.md`, notes) },
      { throw: { message: "Исходный снимок NOTES.md уже возвращён; текущее содержимое после записи не моделируется. Храните актуальные заметки в контексте." } },
    ] },
    { id: "unknown-source", tool: "read_file", outcome: { throw: { message: "Чтение не записано. SPEC.md перечисляет точные пути; произвольные изображения и порядковые имена извлечения не имеют подтверждённых пикселей." } } },
    { id: "reject-replacement", tool: "edit_file", match: { oldString: { minLength: 1 } }, outcome: { throw: { message: "Доступны только полные записанные подстановки без oldString; исходники неизменяемы." } } },
    { id: "edit-props", tool: "edit_file", match: { filePath: { enum: paths("props-v2.json") }, newString: { const: questionProps(2) } },
      outcome: { response: { path: `${P}/props-v2.json`, created: true, replacements: 0, oldContent: "", newContent: questionProps(2), linesAdded: 1, linesRemoved: 0 } } },
    { id: "edit-notes", tool: "edit_file", match: { filePath: { enum: paths("NOTES.md") }, newString: { minLength: 1, maxLength: 262144 }, overwrite: { const: true } },
      outcome: { response: { path: `${P}/NOTES.md`, created: false, replacements: 0, linesAdded: 0, linesRemoved: 0 } } },
    { id: "edit", tool: "edit_file", outcome: { throw: { message: "Правка не записана. Разрешены только полный снимок NOTES.md и точный JSON подстановки props-v2.json из SPEC.md; src и прочие версии неизменяемы." } } },
    { id: "command", tool: "bash", outcome: { throw: { message: "Команда, путь или параметры не записаны в SPEC.md. Успех, запись и пиксели не подтверждены; составные команды не исполнялись." } } },
    { id: "copy", tool: "agent", outcome: { throw: { message: "Собери ролик основным агентом." } } },
    { id: "speech", tool: "speak", outcome: { throw: { message: "Озвучка не нужна." } } },
    { id: "voices", tool: "list_voices", outcome: { response: { voices: [] } } },
    { id: "preview", tool: "set_session_preview", outcome: { throw: { message: "Путь публикации не записан: поддержаны только preview-v1.jpg и preview-v2.jpg этого проекта из SPEC.md." } } },
    blockedRead, emptySearch, isolateDownload,
  );
  if (stubs.length > 100) throw new Error(`Изоляция questions превышает предел 100 правил: ${stubs.length}.`);
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
export const isFinal = (command: string) => !/--scale(?:=|\s)/.test(command) || /--scale(?:=|\s+)1(?:\.0)?(?:\s|$)/.test(command);
