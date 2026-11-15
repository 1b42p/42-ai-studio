import { readFileSync } from "node:fs";
import type { EveEvalContext, ToolStub } from "eve/evals";
import { blockedRead, emptySearch, webSession } from "../web/fixtures";
import audit from "../fixtures/music/integration.json";
import recordings from "../fixtures/music/contract-records.json";
import { MUSIC_PROJECT as P, MUSIC_FRAMES, MUSIC_LEVEL_COMMANDS, MUSIC_PATH, MUSIC_SCENES, SPEC, VOICE, frameName, musicWordsFile, project, sceneName } from "./data";
import { musicFrameOutputs } from "./media-fixture";
import { atomic, esc, quote, pathArg, probePattern, levelPattern, pixelPattern } from "./operation-patterns";

const response = (stdout: string, exitCode = 0, stderr = "") => ({ status: "completed", exitCode, stdout, stderr, truncated: false });
const bash = (id: string, pattern: string, stdout: string, exitCode = 0, stderr = ""): ToolStub => ({ id, tool: "bash", match: { command: { pattern } }, outcome: { response: response(stdout, exitCode, stderr) } });
const reject = (id: string, tool: string, match: ToolStub["match"], message: string): ToolStub => ({ id, tool, match, outcome: { throw: { message } } });
const readResponse = (path: string, content: string) => ({ path, content, totalLines: content.split("\n").length, truncated: false });
const pathForms = (path: string) => [`${P}/${path}`, `calm-bed/${path}`];
const copyTemplate = (source: string, target: string) => `cp\\s+${quote(`(?:\\$HOME|/root)/\\.agents/skills/music-synthesis/templates/${esc(source)}`)}\\s+${pathArg(`src/${target}`)}`;
const cpDuck = copyTemplate("ducking.ts", "ducking.ts");
const cpBackground = copyTemplate("BackgroundMusic.tsx.template", "BackgroundMusic.tsx");
const identicalCopy = `(?:${cpDuck}|${cpBackground}|${cpDuck}\\s*&&\\s*${cpBackground})`;
const jsonProps = (audioMode: string) => {
  const json = JSON.stringify({ audioMode });
  return `(?:${[`'${json}'`, `"${json.replaceAll('"', '\\"')}"`].map(esc).join("|")})`;
};

const references = [
  "music-synthesis/references/mixing.md",
  "music-synthesis/templates/ducking.ts", "music-synthesis/templates/BackgroundMusic.tsx.template",
  "frame-review/references/notes-template.md",
  "voiceover/references/remotion.md",
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
    match: { text: { const: scene.text }, rate: { const: 0 }, outputPath: { enum: pathForms(`public/voice/${sceneName(index)}`) },
      ...(explicit ? { voice: { pattern: "^\\s*ru-RU-SvetlanaNeural\\s*$" } } : {}) },
    outcome: { response: { audioPath: `${P}/public/voice/${sceneName(index)}.mp3`, timingsPath: `${P}/public/voice/${sceneName(index)}.words.json`,
      voice: VOICE, language: "ru-RU", format: "mp3", durationMs: scene.durationMs, wordCount: JSON.parse(musicWordsFile(index)).words.length,
      text: scene.text, media: { audioId: `00000000-0000-4000-8000-00000000000${index + 1}` } } },
  }));
  return [
    // speak's real schema supplies rate=0 before native stub matching. The
    // successful rules enforce it; other rates reach speech-unsupported.
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
  }
  for (const dir of directories) {
    const prefix = dir ? `${dir}/` : "";
    const children = [...new Set([...Object.keys(files), ...Object.keys(cachedSizes)].filter((path) => path.startsWith(prefix)).map((path) => path.slice(prefix.length).split("/")[0]))].sort();
    const listing = children.join("\n") + "\n";
    if (["src", "out/frames-1"].includes(dir)) stubs.push(bash(`ls-${dir}`, atomic(`ls\\s+${pathArg(dir)}`), listing));
  }
  stubs.push(bash("pwd", atomic("pwd"), `${P}\n`));
  // A fixed manifest is not a progress counter. Extra formatting, pipelines and composites are rejected.
  const staticNonempty = Object.keys(files).map(esc).join("|");
  stubs.push(bash("test-source", atomic(`(?:test\\s+-s\\s+${quote(`(?:${esc(P)}/)?(?:${staticNonempty}|out/final\\.mp4)`)}|test\\s+-d\\s+${pathArg("node_modules")}|mkdir\\s+-p\\s+${pathArg("out")}|${identicalCopy})`), ""));
  const size = audit.files["out/final.mp4"].size;
  stubs.push(bash("size-stat", atomic(`stat\\s+-c\\s+${quote("%s")}\\s+${pathArg("out/final.mp4")}`), `${size}\n`));
  stubs.push(bash("size-stat-name", atomic(`stat\\s+-c\\s+'%n %s bytes'\\s+out/final\\.mp4`), `out/final.mp4 ${size} bytes\n`));
  return stubs;
}

export function musicStubs(): ToolStub[] {
  if (recordings.sourceSha256 !== project.sourceSha256 ||
    Object.entries(audit.files).some(([file, metadata]) => (recordings.artifacts as Record<string, string>)[file] !== metadata.sha256)) {
    throw new Error("Записанные операции music-bed относятся к другой версии исходников или аудиоартефактов.");
  }
  const stubs: ToolStub[] = [];
  // One document per response; all alias forms retain the real, installed contents.
  for (const path of references) stubs.push({
    id: `reference-${path}`, tool: "read_file", match: { filePath: { pattern: `^(?:\\$HOME|/root)/\\.agents/skills/${esc(path)}$` } },
    outcome: { response: readResponse(`/root/.agents/skills/${path}`, readFileSync(`agent/skills/${path}`, "utf8")) },
  });
  stubs.push(...musicFrameOutputs.map((output, index): ToolStub => ({ id: `frame-${MUSIC_FRAMES[index]}`, tool: "read_file", match: { filePath: { enum: [output.path, output.path.replace("/workspace/", "")] } }, outcome: { response: output } })));
  stubs.push(reject("journal-replace-unsupported", "edit_file", { filePath: { enum: pathForms("NOTES.md") }, oldString: { minLength: 1 } }, "Write-only журнал не поддерживает поиск и замену старого текста. Передайте полный актуальный снимок NOTES.md в newString без oldString, с overwrite: true."));
  stubs.push({ id: "journal-write", tool: "edit_file", match: { filePath: { enum: pathForms("NOTES.md") } }, outcome: { response: { path: `${P}/NOTES.md`, created: true, replacements: 0, linesAdded: 1, linesRemoved: 0 } } });
  stubs.push(reject("unsupported-edit", "edit_file", undefined, "Правка не поддержана: исходники, субтитры и SPEC.md неизменяемы; разрешён только полный снимок NOTES.md. Файлы вне контракта также не изменяются. Успех правки не подтверждён."));

  const script = `python3?\\s+${quote("(?:\\$HOME|/root)/\\.agents/skills/music-synthesis/scripts/make_music\\.py")}`;
  const musicArgs = `(?:\\s+(?:--mood\\s+calm|--seconds\\s+20(?:\\.0+)?|--seed\\s+1|--lufs\\s+-18(?:\\.0+)?|--bpm\\s+80(?:\\.0+)?|--out\\s+${pathArg("public/music/bg")}))`;
  const musicPattern = atomic(`${script}(?=[^;&\\n]*--mood\\s+calm)(?=[^;&\\n]*--seconds\\s+20(?:\\s|$))(?=[^;&\\n]*--out\\s+${pathArg("public/music/bg")}(?:\\s|$))${musicArgs}+`);
  stubs.push(bash("make-music", musicPattern, JSON.stringify({ audioPath: MUSIC_PATH, durationMs: 20000, bpm: 80, mood: "calm", seed: 1, peakDbfs: -3, integratedLufs: -18 }) + "\n"));
  stubs.push(bash("music-invalid", atomic(`${script}(?![^\\r\\n]*--help)(?:\\s+[^;&\\n]+)?`), "", 1, "Проверьте параметры: --out без расширения, calm, 20 секунд, seed 1, -18 LUFS. Другие параметры не покрыты записанным контрактом.\n"));

  const render = "(?:npx\\s+)?remotion\\s+render\\s+";
  const composition = `${pathArg("src/index.ts")}\\s+Main\\s+`;
  stubs.push(bash("frames-render", atomic(`${render}${composition}${pathArg("out/frames-1")}\\s+--frames=0,100,150,300,450,599(?:\\s+--image-format=jpeg)?(?:\\s+--jpeg-quality=90)?`), MUSIC_FRAMES.map(n => `Rendered out/frames-1/${frameName(n)}`).join("\n")));
  for (const [form, output] of Object.entries(recordings.pixels)) {
    const directory = `${form === "absolute" ? `${P}/` : ""}out/frames-1`;
    const paths = MUSIC_FRAMES.map(frame => `${directory}/${frameName(frame)}`);
    stubs.push({ id: `pixels-${form}`, tool: "bash", match: { command: { pattern: pixelPattern(paths, directory) } }, outcome: { response: output } });
    const singles = recordings.singlePixels[form as keyof typeof recordings.singlePixels];
    paths.forEach((path, index) => stubs.push({
      id: `pixels-${form}-${MUSIC_FRAMES[index]}`, tool: "bash",
      match: { command: { pattern: pixelPattern([path]) } }, outcome: { response: singles[index] },
    }));
  }
  MUSIC_LEVEL_COMMANDS.forEach((command, index) => {
    if (index < 2) {
      const mode = index === 0 ? "voice-only" : "music-only";
      stubs.push(bash(`level-${index}`, atomic(`${render}${composition}${pathArg(`out/${mode}.wav`)}\\s+--props=${jsonProps(mode)}`), `Rendered out/${mode}.wav\n`));
    }
  });
  for (const level of recordings.levels) stubs.push(bash(`measure-${level.file}-${level.scope}`, levelPattern(level.file, level.scope), level.output.stdout, 0, JSON.stringify(level.measurement)));
  const outsideFilter = '[0:a]atrim=start=4.91:end=5.12,asetpts=PTS-STARTPTS[a];[0:a]atrim=start=9.91:end=10.12,asetpts=PTS-STARTPTS[b];[0:a]atrim=start=14.91:end=15.12,asetpts=PTS-STARTPTS[c];[a][b][c]concat=n=3:v=0:a=1,loudnorm=print_format=json';
  stubs.push(bash("measure-outside", levelPattern("out/music-only.wav", "full", outsideFilter), "", 0, JSON.stringify(audit.measurements.musicOutside)));
  stubs.push(bash("final-render", atomic(`${render}${composition}${pathArg("out/final.mp4")}(?:\\s+--props=${jsonProps("mix")})?`), "Rendered out/final.mp4\n"));
  stubs.push(bash("mix-peak", levelPattern("out/final.mp4", "full"), "", 0, JSON.stringify(audit.measurements.mix)));
  // Formats are explicit; unsupported selectors/composites never receive fabricated success.
  for (const profile of recordings.probes) stubs.push({ id: `probe-${profile.id}`, tool: "bash", match: { command: { pattern: probePattern(profile) } }, outcome: { response: profile.output } });
  stubs.push({ id: "decode-without-codec", tool: "bash", match: { command: { pattern: literalCommand("npx remotion ffmpeg -i out/final.mp4 -f null -") } }, outcome: { response: recordings.decodeFailure } });
  // Optional OS diagnostics remain in the audit, not in the bounded playback.
  // Their slots fund exact per-frame responses, without weakening media probes.
  stubs.push(...inspectionStubs(), ...speechStubs());
  stubs.push({ id: "voices", tool: "list_voices", outcome: { response: { voices: [{ name: VOICE, locale: "ru-RU", gender: "Female", displayName: "Светлана", multilingual: false }] } } });
  stubs.push(reject("unknown-read", "read_file", undefined, "Чтение этого пути не записано в контракте; это не доказывает отсутствие файла. NOTES.md — write-only журнал: read-back не поддержан, отказ не означает потерю записи. SPEC.md описывает подготовленный проект, его исходники читаются по точным путям внутри src/. Не подменяйте запрошенный файл другим."));
  stubs.push(reject("unsupported-command", "bash", undefined, "Результат команды не записан в eval-контракте; это не системная ошибка и не отсутствие Python или файла. Успех НЕ подтверждён. check-frames.py поддержан для out/frames-1/*.jpeg, полного списка шести JPEG по возрастанию (все пути относительные либо все абсолютные) и каждого JPEG отдельно. Для другого порядка, подмножества или смешанных путей проверяйте нужные JPEG отдельными вызовами; каждый ответ относится только к переданному кадру. Дождитесь всех шести успешных проверок перед просмотром. Составные команды не поддержаны; неподдержанные параметры не меняют состояние проекта."));
  stubs.push(reject(blockedRead.id, blockedRead.tool, blockedRead.match,
    "Чтение этой страницы не записано в eval-контракте. Это не подтверждает отсутствие страницы; исходники и субтитры подготовленного проекта уже интегрированы и неизменяемы."), emptySearch);
  return stubs;
}

export async function createMusicSession(t: EveEvalContext) {
  return webSession(t, musicStubs());
}
