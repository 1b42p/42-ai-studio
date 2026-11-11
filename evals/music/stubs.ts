import { readFileSync } from "node:fs";
import type { EveEvalContext, ToolStub } from "eve/evals";
import { blockedRead, emptySearch, page, webSession } from "../web/fixtures";
import audit from "../fixtures/music/integration.json";
import { MUSIC_PROJECT as P, MUSIC_FRAMES, MUSIC_LEVEL_COMMANDS, MUSIC_PATH, MUSIC_SCENES, SPEC, VOICE, frameName, musicWordsFile, project, sceneName } from "./data";
import { musicFrameOutputs } from "./media-fixture";

const esc = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const quote = (pattern: string) => {
  const grouped = `(?:${pattern})`;
  return `(?:${grouped}|"${grouped}"|'${grouped}')`;
};
const pathArg = (path: string) => quote(`(?:${esc(P)}/)?${esc(path)}`);
const cwd = `(?:cd\\s+${quote(esc(P))}\\s*&&\\s*)?`;
const atomic = (body: string) => `^\\s*${cwd}${body}\\s*$`;
const response = (stdout: string, exitCode = 0, stderr = "") => ({ status: "completed", exitCode, stdout, stderr, truncated: false });
const bash = (id: string, pattern: string, stdout: string, exitCode = 0, stderr = ""): ToolStub => ({ id, tool: "bash", match: { command: { pattern } }, outcome: { response: response(stdout, exitCode, stderr) } });
const reject = (id: string, tool: string, match: ToolStub["match"], message: string): ToolStub => ({ id, tool, match, outcome: { throw: { message } } });
const readResponse = (path: string, content: string) => ({ path, content, totalLines: content.split("\n").length, truncated: false });
const pathForms = (path: string) => [`${P}/${path}`, `calm-bed/${path}`];

const references = [
  "music-synthesis/references/mixing.md", "music-synthesis/references/benchmarks.md",
  "music-synthesis/templates/ducking.ts", "music-synthesis/templates/BackgroundMusic.tsx.template",
  "frame-review/references/notes-template.md", "frame-review/scripts/check-frames.py",
  "voiceover/references/remotion.md", "remotion-interactivity/timeline-structure.md",
  "remotion-captions/display-captions.md", "remotion-markup/voiceover.md",
  "remotion-markup/calculate-metadata.md", "remotion-multimedia/get-audio-duration.md",
  "remotion-create/video-layout.md", "remotion-markup/compositions.md", "remotion-markup/sequencing.md",
];

function literalCommand(command: string) {
  let pattern = esc(command).replace(/ /g, "\\s+");
  for (const path of ["src/index.ts", "out/voice-only.wav", "out/music-only.wav", "out/final.mp4"]) {
    pattern = pattern.replaceAll(esc(path), `(?:${esc(P)}/)?${esc(path)}`);
  }
  return atomic(pattern);
}

function speechStubs(): ToolStub[] {
  const scenes = (explicit: boolean) => MUSIC_SCENES.map((scene, index): ToolStub => ({
    id: `speech-${index}-${explicit ? "explicit" : "default"}`, tool: "speak",
    match: { text: { const: scene.text }, outputPath: { enum: pathForms(`public/voice/${sceneName(index)}`) },
      ...(explicit ? { voice: { pattern: "^\\s*ru-RU-SvetlanaNeural\\s*$" } } : {}) },
    outcome: { response: { audioPath: `${P}/public/voice/${sceneName(index)}.mp3`, timingsPath: `${P}/public/voice/${sceneName(index)}.words.json`,
      voice: VOICE, language: "ru-RU", format: "mp3", durationMs: scene.durationMs, wordCount: JSON.parse(musicWordsFile(index)).words.length,
      text: scene.text, media: { audioId: `00000000-0000-4000-8000-00000000000${index + 1}` } } },
  }));
  return [
    reject("speech-rate", "speak", { rate: { not: { const: 0 } } }, "Эталон задан для rate=0; не меняйте обычную скорость."),
    ...scenes(true),
    reject("speech-voice", "speak", { voice: { not: { pattern: "^\\s*ru-RU-SvetlanaNeural\\s*$" } } }, "Укажите утверждённый голос Светланы."),
    reject("speech-language", "speak", { language: { not: { pattern: "^\\s*[rR][uU](?:-[rR][uU])?\\s*$" } } }, "Без явного голоса доступен русский default ru/ru-RU."),
    ...scenes(false),
    reject("speech-unsupported", "speak", undefined, "speak_bad_input: нужны точный текст, русский голос Светланы, rate=0 и путь сцены без расширения из SPEC.md."),
  ];
}

function inspectionStubs(): ToolStub[] {
  const stubs: ToolStub[] = [];
  for (const [source, target] of [["ducking.ts", "ducking.ts"], ["BackgroundMusic.tsx.template", "BackgroundMusic.tsx"]]) {
    if (readFileSync(`agent/skills/music-synthesis/templates/${source}`, "utf8") !==
      (project.files as Record<string, string>)[`src/${target}`]) {
      throw new Error(`Шаблон ${source} больше не идентичен неизменяемому проекту.`);
    }
  }
  const files: Record<string, string> = { ...project.files, "SPEC.md": SPEC };
  const cachedSizes: Record<string, number> = {
    ...Object.fromEntries(musicFrameOutputs.map((frame) => [frame.path.slice(P.length + 1), frame.file.size])),
    ...Object.fromEntries(Object.entries(audit.files).map(([path, file]) => [path, file.size])),
  };
  const directories = ["", "src", "public", "public/voice", "public/music", "out", "out/frames-1"];
  for (const [path, content] of Object.entries(files)) {
    stubs.push({ id: `file-${path}`, tool: "read_file", match: { filePath: { enum: pathForms(path) } }, outcome: { response: readResponse(`${P}/${path}`, content) } });
    if (["src/Root.tsx", "SPEC.md"].includes(path)) stubs.push(bash(`cat-${path}`, atomic(`cat\\s+${pathArg(path)}`), content));
  }
  for (const dir of directories) {
    const prefix = dir ? `${dir}/` : "";
    const children = [...new Set([...Object.keys(files), ...Object.keys(cachedSizes)].filter((path) => path.startsWith(prefix)).map((path) => path.slice(prefix.length).split("/")[0]))].sort();
    const listing = children.join("\n") + "\n";
    stubs.push({ id: `directory-${dir || "root"}`, tool: "read_file", match: { filePath: { enum: [`${P}${dir ? `/${dir}` : ""}`, `${P}${dir ? `/${dir}` : ""}/`, `calm-bed${dir ? `/${dir}` : ""}`] } }, outcome: { response: readResponse(`${P}/${dir}`, listing) } });
    stubs.push(bash(`ls-${dir || "root"}`, atomic(`ls${dir ? `\\s+${pathArg(dir)}` : `(?:\\s+${quote(`${esc(P)}|\\.`)})?`}`), listing));
  }
  stubs.push(bash("pwd", atomic("pwd"), `${P}\n`));
  // A fixed manifest is not a progress counter. Extra formatting, pipelines and composites are rejected.
  stubs.push(bash("find-project", atomic(`(?:find\\s+${quote(esc(P))}(?:\\s+-maxdepth\\s+[3-9])?\\s+-type\\s+f|rg\\s+--files\\s+${quote(esc(P))})`), [...Object.keys(files), ...Object.keys(cachedSizes)].map(path => `${P}/${path}`).join("\n") + "\n"));
  const staticNonempty = Object.keys(files).map(esc).join("|");
  stubs.push(bash("test-source", atomic(`test\\s+-s\\s+${quote(`(?:${esc(P)}/)?(?:${staticNonempty})`)}`), ""));
  stubs.push(bash("test-node-modules", atomic(`test\\s+-d\\s+${pathArg("node_modules")}`), ""));
  const size = audit.files["out/final.mp4"].size;
  stubs.push(bash("size-test", atomic(`test\\s+-s\\s+${pathArg("out/final.mp4")}`), ""));
  stubs.push(bash("size-stat", atomic(`stat\\s+-c\\s+${quote("%s")}\\s+${pathArg("out/final.mp4")}`), `${size}\n`));
  stubs.push(bash("size-stat-name", atomic(`stat\\s+-c\\s+'%n %s bytes'\\s+out/final\\.mp4`), `out/final.mp4 ${size} bytes\n`));
  return stubs;
}

export function musicStubs(): ToolStub[] {
  const stubs: ToolStub[] = [];
  // One document per response; all alias forms retain the real, installed contents.
  for (const [index, path] of references.entries()) stubs.push({
    id: `reference-${index}`, tool: "read_file", match: { filePath: { pattern: `^(?:\\$HOME|/root)/\\.agents/skills/${esc(path)}$` } },
    outcome: { response: readResponse(`/root/.agents/skills/${path}`, readFileSync(`agent/skills/${path}`, "utf8")) },
  });
  stubs.push(...musicFrameOutputs.map((output, index): ToolStub => ({ id: `frame-${MUSIC_FRAMES[index]}`, tool: "read_file", match: { filePath: { enum: [output.path, output.path.replace("/workspace/", "")] } }, outcome: { response: output } })));
  stubs.push(reject("journal-read", "read_file", { filePath: { pattern: "(?:^|/)NOTES\\.md$" } }, "NOTES.md — write-only журнал этого задания, read-back не поддержан. Исходные условия и контрольные кадры находятся в неизменяемом SPEC.md. Не делайте вывод, что запись потеряна."));
  stubs.push(reject("source-edit", "edit_file", { filePath: { pattern: "(?:^|/)(?:src/|SPEC\\.md$|package\\.json$|tsconfig\\.json$)" } }, "Исходники, субтитры и SPEC.md уже интегрированы и неизменяемы. Нужны повторный синтез, рендеры и проверки, не правка графики."));
  stubs.push(reject("journal-replace-unsupported", "edit_file", { filePath: { enum: pathForms("NOTES.md") }, oldString: { minLength: 1 } }, "Write-only журнал не поддерживает поиск и замену старого текста. Передайте полный актуальный снимок NOTES.md в newString без oldString, с overwrite: true."));
  stubs.push({ id: "journal-write", tool: "edit_file", match: { filePath: { enum: pathForms("NOTES.md") } }, outcome: { response: { path: `${P}/NOTES.md`, created: true, replacements: 0, linesAdded: 1, linesRemoved: 0 } } });
  stubs.push(reject("unsupported-edit", "edit_file", undefined, "Файл вне записанного контракта. Успех правки не подтверждён."));

  const copy = (source: string, target: string) => `cp\\s+${quote(`(?:\\$HOME|/root)/\\.agents/skills/music-synthesis/templates/${esc(source)}`)}\\s+${pathArg(`src/${target}`)}`;
  const cpDuck = copy("ducking.ts", "ducking.ts");
  const cpBackground = copy("BackgroundMusic.tsx.template", "BackgroundMusic.tsx");
  stubs.push(bash("same-template-copy", atomic(`(?:${cpDuck}|${cpBackground}|${cpDuck}\\s*&&\\s*${cpBackground})`), ""));

  const script = `python3?\\s+${quote("(?:\\$HOME|/root)/\\.agents/skills/music-synthesis/scripts/make_music\\.py")}`;
  const musicArgs = `(?:\\s+(?:--mood\\s+calm|--seconds\\s+20(?:\\.0+)?|--seed\\s+1|--lufs\\s+-18(?:\\.0+)?|--bpm\\s+80(?:\\.0+)?|--out\\s+${pathArg("public/music/bg")}))`;
  const musicPattern = atomic(`${script}(?=[^;&\\n]*--mood\\s+calm)(?=[^;&\\n]*--seconds\\s+20(?:\\s|$))(?=[^;&\\n]*--out\\s+${pathArg("public/music/bg")}(?:\\s|$))${musicArgs}+`);
  stubs.push(bash("make-music", musicPattern, JSON.stringify({ audioPath: MUSIC_PATH, durationMs: 20000, bpm: 80, mood: "calm", seed: 1, peakDbfs: -3, integratedLufs: -18 }) + "\n"));
  stubs.push(bash("music-help", atomic(`${script}\\s+--help`), "--mood calm --seconds 20 --seed 1 --lufs -18 --out /workspace/calm-bed/public/music/bg (без расширения)\n"));
  stubs.push(bash("music-invalid", atomic(`${script}(?:\\s+[^;&\\n]+)?`), "", 1, "Проверьте параметры: --out без расширения, calm, 20 секунд, seed 1, -18 LUFS. Другие параметры не покрыты записанным контрактом.\n"));

  const render = "(?:npx\\s+)?remotion\\s+render\\s+";
  const composition = `${pathArg("src/index.ts")}\\s+Main\\s+`;
  stubs.push(bash("frames-render", atomic(`${render}${composition}${pathArg("out/frames-1")}\\s+--frames=0,100,150,300,450,599(?:\\s+--image-format=jpeg)?(?:\\s+--jpeg-quality=90)?`), MUSIC_FRAMES.map(n => `Rendered out/frames-1/${frameName(n)}`).join("\n")));
  stubs.push(bash("pixels", atomic(`python3?\\s+${quote("(?:\\$HOME|/root)/\\.agents/skills/frame-review/scripts/check-frames\\.py")}\\s+${pathArg("out/frames-1")}\\/\\*\\.jpeg`), MUSIC_FRAMES.map(n => `${frameName(n)} 1920x1080 ok`).join("\n")));
  MUSIC_LEVEL_COMMANDS.forEach((command, index) => {
    const key = ["voiceFull", "voiceSpeech", "musicSpeech", "musicOutside"][index - 2] as keyof typeof audit.measurements;
    stubs.push(bash(`level-${index}`, literalCommand(command), index < 2 ? `Rendered out/${index === 0 ? "voice-only" : "music-only"}.wav\n` : "", 0, index < 2 ? "" : JSON.stringify(audit.measurements[key])));
  });
  const mixJson = JSON.stringify({ audioMode: "mix" });
  const mixProps = [`'${mixJson}'`, `"${mixJson.replaceAll('"', '\\"')}"`].map(esc).join("|");
  stubs.push(bash("final-render", atomic(`${render}${composition}${pathArg("out/final.mp4")}(?:\\s+--props=(?:${mixProps}))?`), "Rendered out/final.mp4\n"));
  stubs.push(bash("mix-peak", literalCommand("npx remotion ffmpeg -i out/final.mp4 -vn -af loudnorm=print_format=json -f null -"), "", 0, JSON.stringify(audit.measurements.mix)));
  stubs.push(bash("compositions", atomic(`(?:npx\\s+)?remotion\\s+compositions\\s+${pathArg("src/index.ts")}`), "Main 1920x1080 30fps 600 frames\n"));
  // Formats are explicit; unsupported selectors/composites never receive fabricated success.
  const probeOptions = "(?:\\s+-v\\s+error)?\\s+-show_streams\\s+-show_format";
  for (const format of ["json", "default"] as const) {
    const probe = audit.files["out/final.mp4"].probe;
    const section = (name: string, values: Record<string, unknown>) => [
      `[${name}]`, ...Object.entries(values).filter(([, value]) => typeof value !== "object").map(([key, value]) => `${key}=${value}`), `[/${name}]`,
    ].join("\n");
    const output = format === "json" ? JSON.stringify(probe) : probe.streams.map(stream => section("STREAM", stream)).concat(section("FORMAT", probe.format)).join("\n") + "\n";
    stubs.push(bash(`probe-${format === "json" ? "json" : "default"}`, atomic(`(?:npx\\s+)?remotion\\s+ffprobe${probeOptions}\\s+-(?:of|print_format)(?:=|\\s+)${quote(format)}\\s+${pathArg("out/final.mp4")}`), output));
  }
  stubs.push(...inspectionStubs(), ...speechStubs());
  stubs.push({ id: "voices", tool: "list_voices", outcome: { response: { voices: [{ name: VOICE, locale: "ru-RU", gender: "Female", displayName: "Светлана", multilingual: false }] } } });
  stubs.push({ id: "caption-doc", tool: "read_page", match: { url: { pattern: "^https://www\\.remotion\\.dev/elements/captions/basic-captions(?:\\.md)?$" } }, outcome: { response: page("https://www.remotion.dev/elements/captions/basic-captions.md", "Basic Captions", readFileSync("evals/fixtures/voiceover/basic-captions.md", "utf8")) } });
  stubs.push(reject("unknown-read", "read_file", undefined, "Путь отсутствует в неизменяемом манифесте. Не подменяйте его другим файлом; SPEC.md описывает весь видеоряд."));
  stubs.push(reject("unsupported-command", "bash", undefined, "Полный результат этой команды не записан. Успех НЕ подтверждён. Разделите составные команды на отдельные операции из SPEC.md; неподдержанные параметры не меняют состояние проекта."));
  stubs.push(blockedRead, emptySearch);
  return stubs;
}

export async function createMusicSession(t: EveEvalContext) {
  return webSession(t, musicStubs());
}
