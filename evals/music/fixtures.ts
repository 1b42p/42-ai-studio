import type { EveEvalContext, ToolStub } from "eve/evals";
import { blockedRead, emptySearch, webSession } from "../web/fixtures";

export const MUSIC_PROJECT = "/workspace/calm-bed";
export const MUSIC_PATH = `${MUSIC_PROJECT}/public/music/bg.wav`;
export const MUSIC_TIMEOUT_MS = 60 * 60 * 1000;

const MUSIC_JSON = JSON.stringify({
  audioPath: "public/music/bg.wav",
  durationMs: 20000,
  bpm: 80,
  mood: "calm",
  seed: 1,
  peakDbfs: -3,
  integratedLufs: -24,
});

const LOUDNORM = [
  "{",
  "  \"input_i\" : \"-23.5\",",
  "  \"input_tp\" : \"-2.0\",",
  "  \"input_lra\" : \"4.0\",",
  "  \"input_thresh\" : \"-33.5\",",
  "  \"output_i\" : \"-24.0\",",
  "  \"output_tp\" : \"-2.1\",",
  "  \"output_lra\" : \"4.0\",",
  "  \"output_thresh\" : \"-34.0\",",
  "  \"normalization_type\" : \"dynamic\",",
  "  \"target_offset\" : \"0.5\"",
  "}",
].join("\n");

const SCENES = [
  { durationMs: 3000, wordCount: 2 },
  { durationMs: 8000, wordCount: 6 },
  { durationMs: 4000, wordCount: 3 },
  { durationMs: 3000, wordCount: 3 },
] as const;

function bash(id: string, pattern: string, stdout: string, stderr = ""): ToolStub {
  return {
    id,
    tool: "bash",
    match: { command: { pattern } },
    outcome: { response: { status: "completed", exitCode: 0, stdout, stderr, truncated: false } },
  };
}

function sceneName(index: number): string {
  return `scene-${String(index + 1).padStart(2, "0")}`;
}

function wordsFile(index: number): string {
  const scene = SCENES[index];
  return JSON.stringify({
    version: 1,
    sentences: [{ startMs: 0, endMs: scene.durationMs }],
  }, null, 2);
}

const PROJECT_TEXT = [
  "src/Root.tsx",
  "public/music/bg.wav",
  ...SCENES.map((_, index) => `public/voice/${sceneName(index)}.mp3`),
  ...SCENES.map((_, index) => `public/voice/${sceneName(index)}.words.json`),
  "NOTES.md",
].join("\n");

const WORDS_STDOUT = SCENES.map((_, index) =>
  `== public/voice/${sceneName(index)}.words.json\n${wordsFile(index)}`).join("\n");

function speakScene(index: number): ToolStub {
  const scene = SCENES[index];
  const name = sceneName(index);
  return {
    id: `speak-${name}`,
    tool: "speak",
    match: { outputPath: { pattern: name } },
    outcome: {
      response: {
        audioPath: `public/voice/${name}.mp3`,
        timingsPath: `public/voice/${name}.words.json`,
        voice: "ru-RU-SvetlanaNeural",
        language: "ru-RU",
        format: "mp3",
        durationMs: scene.durationMs,
        wordCount: scene.wordCount,
        text: "",
        media: { audioId: `00000000-0000-4000-8000-00000000000${index + 1}` },
      },
    },
  };
}

function wordsRead(index: number): ToolStub {
  const name = sceneName(index);
  return {
    id: `words-${name}`,
    tool: "read_file",
    match: { filePath: { pattern: `${name}\\.words\\.json$` } },
    outcome: {
      response: {
        path: `public/voice/${name}.words.json`,
        content: wordsFile(index),
        totalLines: 6,
        truncated: false,
      },
    },
  };
}

export async function musicSession(t: EveEvalContext) {
  return webSession(t, [
    bash("make-music", "make_music\\.py", `${MUSIC_JSON}\n`),
    bash("loudnorm", "loudnorm=", `${LOUDNORM}\n`, LOUDNORM),
    bash("ffprobe", "ffprobe", `${SCENES.map((scene) => `duration=${(scene.durationMs / 1000).toFixed(3)}`).join("\n")}\n`),
    bash("words-cat", "words\\.json", `${WORDS_STDOUT}\n`),
    bash("skill-files", "\\.agents/skills", "Навык уже загружен в этот ход.\n"),
    bash("render", "remotion (render|still|compositions)", "Rendered out/final.mp4\n"),
    bash("setup", "mkdir|pip install|\\bln\\s|\\bcp\\s", "src/Root.tsx\npublic/voice\npublic/music\npackage.json\n"),
    bash("template", "/opt/remotion", "package.json\nsrc\ntsconfig.json\nremotion.config.ts\nnode_modules\n"),
    bash("stat", "\\bstat\\b", "public/voice/scene-01.mp3 48000 bytes\npublic/music/bg.wav 3528444 bytes\n"),
    bash("pwd", "(^|[;&|]\\s*)pwd(\\s|$)", "/workspace\n"),
    bash("echo", "\\becho\\b", "ok\n"),
    bash("find", "\\bfind\\b", `${PROJECT_TEXT}\n`),
    bash("ls", "\\bls\\b", `${PROJECT_TEXT}\n`),
    bash("cat", "\\bcat\\b", "export const Root = () => null;\n"),
    {
      id: "bash-rest",
      tool: "bash",
      outcome: { response: { status: "completed", exitCode: 0, stdout: "ok\n", stderr: "", truncated: false } },
    },
    ...SCENES.map((_, index) => speakScene(index)),
    {
      id: "speak",
      tool: "speak",
      outcome: {
        response: {
          audioPath: "public/voice/scene-01.mp3",
          timingsPath: "public/voice/scene-01.words.json",
          voice: "ru-RU-SvetlanaNeural",
          language: "ru-RU",
          format: "mp3",
          durationMs: SCENES[0].durationMs,
          wordCount: SCENES[0].wordCount,
          text: "",
          media: { audioId: "00000000-0000-4000-8000-000000000001" },
        },
      },
    },
    {
      id: "edit",
      tool: "edit_file",
      outcome: {
        response: {
          path: "src/Root.tsx",
          created: true,
          replacements: 1,
          oldContent: "",
          newContent: "",
          linesAdded: 1,
          linesRemoved: 0,
        },
      },
    },
    ...SCENES.map((_, index) => wordsRead(index)),
    {
      id: "frame",
      tool: "read_file",
      match: { filePath: { pattern: "\\.(jpe?g|png)$" } },
      outcome: {
        response: {
          path: "out/frames-1/element-001.jpeg",
          content: "Image 1920x1080",
          totalLines: 1,
          truncated: false,
          file: { mediaType: "image/jpeg", width: 1920, height: 1080, size: 12000 },
        },
      },
    },
    {
      id: "audio-file",
      tool: "read_file",
      match: { filePath: { pattern: "\\.(mp3|wav)$" } },
      outcome: {
        response: {
          path: "public/music/bg.wav",
          content: "аудиофайл, 48000 байт",
          totalLines: 1,
          truncated: false,
        },
      },
    },
    {
      id: "project-file",
      tool: "read_file",
      outcome: {
        response: {
          path: "src/Root.tsx",
          content: "export const Root = () => null;\n",
          totalLines: 1,
          truncated: false,
        },
      },
    },
    {
      id: "voices",
      tool: "list_voices",
      outcome: {
        response: {
          voices: [{
            name: "ru-RU-SvetlanaNeural",
            locale: "ru-RU",
            gender: "Female",
            displayName: "Светлана",
            multilingual: false,
          }],
        },
      },
    },
    blockedRead,
    emptySearch,
  ]);
}
