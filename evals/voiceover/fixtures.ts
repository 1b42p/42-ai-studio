import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import type { EveEvalContext, ToolStub } from "eve/evals";
import { blockedRead, emptySearch, page, webSession } from "../web/fixtures";

export const PROJECT = "/workspace/coffee-voiceover";
export const VOICE = "ru-RU-SvetlanaNeural";
export const PIPER_VOICE = "ru_RU-denis-medium";
export const VOICEOVER_TIMEOUT_MS = 30 * 60 * 1000;
export const SCENES = [
  "Насыпьте свежий кофе. Добавьте горячую воду без кипения.",
  "Подождите немного. Дайте вкусу раскрыться в тёплой чашке.",
  "Сделайте первый глоток. Насладитесь ароматом и спокойным утром.",
] as const;

export const VOICEOVER_REQUEST = `Сделай вертикальный ролик 9:16, 1080×1920, 30 кадров/с, ` +
  `примерно на шестнадцать секунд, для любителей домашнего кофе. Три сцены с простой ` +
  `motion-графикой, без музыки и внешних материалов. Русская озвучка голосом Светланы ` +
  `(${VOICE}), обычная скорость, и субтитры с выделением произносимого слова. ` +
  `Длительность подстрой под фактическую речь. Каталог проекта: ${PROJECT}. ` +
  `Точные тексты озвучки по сценам:\n${SCENES.map((text, i) => `${i + 1}. ${text}`).join("\n")}\n` +
  `Если выбранный голос недоступен, можно использовать другой русский голос. ` +
  `Дополнительных пожеланий нет, сразу делай готовый MP4.`;

const sceneBase = (index: number, fallback = false) =>
  `${PROJECT}/public/voice/scene-${String(index + 1).padStart(2, "0")}${fallback ? "-piper" : ""}`;

/** Синтетические границы: два предложения, пауза 400 мс, конец речи 4500 мс. */
function timings(text: string, fallback: boolean) {
  const tokens = text.split(/\s+/u);
  const sentenceEnd = tokens.findIndex((word) => /[.!?]$/u.test(word));
  const words = tokens.map((word, index) => {
    const startMs = 100 + index * 500 + (index > sentenceEnd ? 400 : 0);
    return { text: word, startMs, endMs: startMs + 500 };
  });
  return {
    version: 1, voice: fallback ? `piper:${PIPER_VOICE}` : VOICE,
    language: "ru-RU", format: fallback ? "wav" : "mp3", durationMs: 4500, text,
    words,
    sentences: [
      { text: tokens.slice(0, sentenceEnd + 1).join(" "), startMs: words[0].startMs,
        endMs: words[sentenceEnd + 1].startMs },
      { text: tokens.slice(sentenceEnd + 1).join(" "), startMs: words[sentenceEnd + 1].startMs,
        endMs: words.at(-1)!.endMs },
    ],
  };
}

function readResponse(path: string, text: string) {
  return { path, content: text.split("\n").map((line, index) => `${index + 1}: ${line}`).join("\n"),
    totalLines: text.split("\n").length, truncated: false };
}

const bashResponse = (stdout: string) => ({ status: "completed", exitCode: 0, stdout, stderr: "", truncated: false });
const escapePattern = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const commandStub = (id: string, pattern: string, stdout: string): ToolStub => ({
  id, tool: "bash", match: { command: { pattern } }, outcome: { response: bashResponse(stdout) },
});

/** Читаются настоящие вспомогательные файлы навыков, не выдуманные инструкции. */
function skillFiles(): ToolStub[] {
  const root = join(process.cwd(), "agent/skills");
  const paths = readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name !== "SKILL.md" && /\.(?:md|py)$/u.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name))
    .filter((path) => !path.includes("/remotion-maps/") && !path.includes("/assets/"))
    .sort();
  return paths.map((path, index) => {
    const suffix = relative(root, path).split("\\").join("/");
    return { id: `skill-file-${index}`, tool: "read_file",
      match: { filePath: { pattern: `(?:^|/)skills/${escapePattern(suffix)}$` } },
      outcome: { response: readResponse(`/root/.agents/skills/${suffix}`, readFileSync(path, "utf8")) } };
  });
}

// Выдержка API Remotion 4.0.538: packages/docs/docs/captions/create-tiktok-style-captions.mdx.
const CAPTIONS_DOCS = `Caption has text, startMs, endMs, timestampMs and confidence (number | null).
Times are milliseconds. Whitespace belongs before each word except the first.
createTikTokStyleCaptions({captions, combineTokensWithinMilliseconds, breakOnSilenceAfterMilliseconds})
returns {pages}. A page has text, startMs, durationMs and tokens with text, fromMs, toMs.
A silence gap at least breakOnSilenceAfterMilliseconds starts a new page.
The previous page extends until the next starts. Preserve whitespace with white-space: pre.`;

const FRAME_NAMES = [0, 40, 120, 160, 240, 320, 400, 479].map((frame) => `element-${String(frame).padStart(3, "0")}.jpeg`);
const probe = {
  streams: [
    { codec_name: "h264", codec_type: "video", width: 1080, height: 1920, r_frame_rate: "30/1", duration: "16.000000" },
    { codec_name: "aac", codec_type: "audio", sample_rate: "48000", channels: 2, duration: "16.000000" },
  ],
  format: { duration: "16.000000", size: "1048576" },
};

function mediaStubs(fallback: boolean): ToolStub[] {
  const audioExtension = fallback ? "wav" : "mp3";
  const generated = SCENES.map((text, index) => ({
    audioPath: `${sceneBase(index, true)}.wav`, timingsPath: `${sceneBase(index, true)}.words.json`,
    durationMs: 4500, words: timings(text, true).words.length, mode: "alignment",
  }));
  return [
    ...SCENES.flatMap((text, index): ToolStub[] => [
      {
        id: `timings-${index}`, tool: "read_file",
        match: { filePath: { pattern: `scene-0?${index + 1}(?:-piper)?\\.words\\.json$` } },
        outcome: { response: readResponse(`${sceneBase(index, fallback)}.words.json`, JSON.stringify(timings(text, fallback), null, 2)) },
      },
      commandStub(`bash-timings-${index}`, `(?:cat|readFile|open)[\\s\\S]*scene-0?${index + 1}(?:-piper)?\\.words\\.json`,
        JSON.stringify(timings(text, fallback))),
      commandStub(`piper-scene-${index}`, `piper_speak\\.py[\\s\\S]*--out[\\s\\S]*scene-0?${index + 1}-piper(?:[\\s"']|$)`,
        JSON.stringify(generated[index])),
    ]),
    commandStub("piper-batch", "piper_speak\\.py", generated.map((result) => JSON.stringify(result)).join("\n")),
    commandStub("piper-download", "piper\\.download_voices", `/root/.cache/piper/${PIPER_VOICE}.onnx\n/root/.cache/piper/${PIPER_VOICE}.onnx.json\n`),
    commandStub("piper-install", "(?:pip|pip3)[\\s\\S]*install[\\s\\S]*piper", "Successfully installed piper-tts-1.8.0 onnx-1.19.1 onnxruntime-1.23.2\n"),
    commandStub("probe-audio", "(?:ffprobe|getAudioDuration)[\\s\\S]*\\.(?:mp3|wav)",
      JSON.stringify({ streams: [{ codec_type: "audio", codec_name: fallback ? "pcm_s16le" : "mp3", duration: "4.500000" }], format: { duration: "4.500000" } })),
    commandStub("probe-mp4-json", "ffprobe[\\s\\S]*(?:-of|-print_format)[ =]+json", JSON.stringify(probe)),
    commandStub("probe-mp4", "ffprobe[\\s\\S]*\\.mp4", "codec_name=h264\ncodec_type=video\nwidth=1080\nheight=1920\nduration=16.000000\ncodec_name=aac\ncodec_type=audio\nduration=16.000000\nduration=16.000000\n"),
    commandStub("frame-pixels", "check-frames\\.py", FRAME_NAMES.map((name) => JSON.stringify({
      path: `out/frames-1/${name}`, extrema: [[15, 248], [23, 250], [42, 252]], suspect: null,
    })).join("\n")),
    commandStub("render-frames", "remotion[\\s\\S]*(?:\\bstill\\b|--frames|--sequence)",
      `Rendered frames (8/8)\n${FRAME_NAMES.map((name) => `out/frames-1/${name}`).join("\n")}\n`),
    commandStub("list-frames", "(?:ls|find)[\\s\\S]*(?:frames|\\.jpe?g|\\.png)", FRAME_NAMES.join("\n")),
    commandStub("render-mp4", "remotion\\s+render[\\s\\S]*\\.mp4", "Rendered 480/480\nEncoded 480/480\nOutput: out/coffee-voiceover.mp4 (1.0 MB)\n"),
    commandStub("composition-metadata", "remotion\\s+compositions", "Main  30 fps  1080×1920  480 frames (16.00 sec)\n"),
    commandStub("file-size", "(?:stat|wc -c)[\\s\\S]*\\.(?:mp4|jpe?g|png|wav|mp3)", "1048576\n"),
    commandStub("vcpu", "^\\s*sandbox-vcpu\\s*$", "2\n"),
    commandStub("disk", "df\\s+-h", "Filesystem Size Used Avail Use% Mounted on\noverlay 5.0G 120M 4.9G 3% /workspace\n"),
    commandStub("files", "(?:ls|find)[\\s\\S]*/(?:public|voice)(?:/|[\\s\"']|$)", SCENES.flatMap((_, index) =>
      [`${sceneBase(index, fallback)}.${audioExtension}`, `${sceneBase(index, fallback)}.words.json`]).join("\n")),
    commandStub("project-listing", "(?:ls|find|os\\.listdir)[\\s\\S]*(?:/workspace|/opt/remotion)",
      "package.json\ntsconfig.json\nremotion.config.ts\nsrc/\nsrc/index.ts\nsrc/Root.tsx\npublic/\n"),
  ];
}

/** Все побочные эффекты подменены; eve__skill продолжает загружать настоящий навык. */
export async function voiceoverSession(t: EveEvalContext, fallback: boolean) {
  const stubs: ToolStub[] = [
    ...skillFiles(),
    ...mediaStubs(fallback),
    ...(fallback ? [{ id: "speech-unavailable", tool: "speak",
      outcome: { throw: { message: "speak_unavailable: Сервис озвучки сейчас недоступен (после трёх попыток)." } },
    } satisfies ToolStub] : SCENES.map((text, index): ToolStub => ({
      id: `speech-${index}`, tool: "speak", match: { text: { const: text } },
      outcome: { response: { audioPath: `${sceneBase(index)}.mp3`, timingsPath: `${sceneBase(index)}.words.json`,
        voice: VOICE, language: "ru-RU", format: "mp3", durationMs: 4500, wordCount: 8, text,
        media: { audioId: `00000000-0000-4000-8000-00000000000${index + 1}` } } },
    }))),
    { id: "voices", tool: "list_voices", outcome: { response: { voices: [
      { name: VOICE, locale: "ru-RU", gender: "Female", displayName: "Светлана", multilingual: false },
    ] } } },
    { id: "captions-docs", tool: "read_page", match: { url: { pattern: "^https://www\\.remotion\\.dev/docs/captions(?:/|\\.md|$)" } },
      outcome: { response: page("https://www.remotion.dev/docs/captions/create-tiktok-style-captions", "createTikTokStyleCaptions", CAPTIONS_DOCS, "en") } },
    {
      id: "frame-unavailable", tool: "read_file", match: { filePath: { pattern: "\\.(?:jpe?g|png)$" } },
      // Поле file включило бы настоящий getSandbox() в read_file.toModelOutput.
      // Нельзя выдавать описание вместо пикселей или подсказывать зачесть его просмотром.
      outcome: { response: { path: `${PROJECT}/out/frames-1/element-120.jpeg`, totalLines: 1, truncated: false,
        content: "Изображение не загружено: полностью изолированная фикстура read_file не передаёт бинарные медиа. Пиксели кадра недоступны." } },
    },
    { id: "project-notes", tool: "read_file", match: { filePath: { pattern: "(?:^|/)NOTES\\.md$" } },
      outcome: { response: readResponse(`${PROJECT}/NOTES.md`, readFileSync("agent/skills/frame-review/references/notes-template.md", "utf8")) } },
    ...["NOTES.md", ...SCENES.map((_, index) => `voice/scene-${String(index + 1).padStart(2, "0")}.txt`)]
      .map((path, index): ToolStub => ({ id: `edit-text-${index}`, tool: "edit_file",
        match: { filePath: { pattern: `(?:^|/)${escapePattern(path)}$` } },
        outcome: { response: { path: `${PROJECT}/${path}`, created: true, replacements: 0,
          oldContent: null, newContent: "", linesAdded: 1, linesRemoved: 0 } } })),
    { id: "edit-success", tool: "edit_file", outcome: { response: { path: `${PROJECT}/src/Root.tsx`,
      created: true, replacements: 0, oldContent: null, newContent: "", linesAdded: 1, linesRemoved: 0 } } },
    { id: "unknown-read", tool: "read_file", outcome: { throw: { message: "File not found in the isolated voiceover fixture." } } },
    { id: "shell-success", tool: "bash", outcome: { response: bashResponse("Command completed.\n") } },
    blockedRead, emptySearch,
  ];
  return webSession(t, stubs);
}
