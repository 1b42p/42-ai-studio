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
  { durationMs: 2000, wordCount: 2 },
  { durationMs: 4000, wordCount: 4 },
  { durationMs: 2500, wordCount: 3 },
  { durationMs: 2000, wordCount: 2 },
] as const;

function bashResult(stdout: string, stderr = "") {
  return { response: { status: "completed" as const, exitCode: 0, stdout, stderr, truncated: false } };
}

function bash(id: string, pattern: string, stdout: string, stderr = ""): ToolStub {
  return {
    id,
    tool: "bash",
    match: { command: { pattern } },
    outcome: bashResult(stdout, stderr),
  };
}

function bashSequence(id: string, pattern: string, stdouts: readonly [string, ...string[]]): ToolStub {
  return {
    id,
    tool: "bash",
    match: { command: { pattern } },
    outcomes: stdouts.map((stdout) => bashResult(stdout)) as ToolStub["outcomes"],
  };
}

function sceneName(index: number): string {
  return `scene-${String(index + 1).padStart(2, "0")}`;
}

const ROOT_SRC = [
  'import { AbsoluteFill, Audio, Sequence, staticFile } from "remotion";',
  'import { BackgroundMusic } from "./BackgroundMusic";',
  "",
  "export const RemotionRoot = () => (",
  "  <AbsoluteFill>",
  '    <BackgroundMusic src={staticFile("music/bg.wav")} />',
  "    <Sequence durationInFrames={120}>",
  '      <Audio src={staticFile("voice/scene-01.mp3")} volume={0.73} />',
  "    </Sequence>",
  "  </AbsoluteFill>",
  ");",
  "",
].join("\n");

const DUCKING_SRC = [
  "export function duckingGain(frame: number, fps: number, speech: { startMs: number; endMs: number }[]) {",
  "  const ms = (frame / fps) * 1000;",
  "  const spoken = speech.some((item) => ms >= item.startMs - 200 && ms <= item.endMs + 400);",
  "  return spoken ? 0.4 : 1;",
  "}",
  "",
].join("\n");

const BACKGROUND_SRC = [
  'import { Audio, staticFile, useCurrentFrame } from "remotion";',
  'import { duckingGain } from "./ducking";',
  "",
  "export const BackgroundMusic = ({ speech }: { speech: { startMs: number; endMs: number }[] }) => {",
  "  const frame = useCurrentFrame();",
  "  return <Audio src={staticFile(\"music/bg.wav\")} volume={duckingGain(frame, 30, speech)} />;",
  "};",
  "",
].join("\n");

const INDEX_SRC = [
  'import { registerRoot } from "remotion";',
  'import { RemotionRoot } from "./Root";',
  "",
  "registerRoot(RemotionRoot);",
  "",
].join("\n");

function wordsFile(index: number): string {
  const scene = SCENES[index];
  const weights = Array.from({ length: scene.wordCount }, (_, word) => 0.55 + ((word * 37 + index * 13) % 10) / 10);
  const weightSum = weights.reduce((total, weight) => total + weight, 0);
  let cursor = 0;
  const words = weights.map((weight) => {
    const startMs = Math.round(cursor);
    cursor += (scene.durationMs * weight) / weightSum;
    return { startMs, endMs: Math.min(scene.durationMs, Math.round(cursor)) };
  });
  if (words.length > 0) words[words.length - 1] = { ...words[words.length - 1], endMs: scene.durationMs };
  return JSON.stringify({
    version: 1,
    sentences: [{ startMs: 0, endMs: scene.durationMs }],
    words,
  }, null, 2);
}

const TEMPLATE_TEXT = ["src/Root.tsx", "src/index.ts", "public", "package.json", "NOTES.md"].join("\n");

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
        totalLines: 24,
        truncated: false,
      },
    },
  };
}

export async function musicSession(t: EveEvalContext) {
  return webSession(t, [
    bash("music-help", "make_music\\.py[^\\n]*--help", "usage: make_music.py --mood calm|upbeat|dramatic --seconds N --out PATH\n"),
    bash("make-music", "make_music\\.py", `${MUSIC_JSON}\n`),
    bash("check-frames", "check-frames\\.py", "element-00.jpeg 1920x1080 ok\nelement-030.jpeg 1920x1080 ok\n"),
    bash("loudnorm", "loudnorm=", `${LOUDNORM}\n`, LOUDNORM),
    bash("ffprobe", "ffprobe", `${SCENES.map((scene) => `duration=${(scene.durationMs / 1000).toFixed(3)}`).join("\n")}\ncodec_type=audio\nduration=20.000\n`),
    bash("words-cat", "words\\.json", `${WORDS_STDOUT}\n`),
    bash("skill-doc", "SKILL\\.md", "Навык уже загружен в этот ход.\n"),
    bash("frames-render", "--frames=", "Rendered out/frames-1/element-00.jpeg\nRendered out/frames-1/element-030.jpeg\n"),
    bash("still", "remotion still", "Rendered out/frames-1/check.jpeg\n"),
    bash("render", "remotion render", "Rendered out/final.mp4\n"),
    bash("compositions", "remotion compositions", "Main\n"),
    bash("setup", "mkdir|pip install|\\bln\\s|\\bcp\\s", "template copied\n"),
    bash("template", "^[^;&|]*\\/opt\\/remotion[^;&|]*$", "package.json\nsrc\ntsconfig.json\nremotion.config.ts\nnode_modules\n"),
    bash("file-size", "test -s", "SIZE=8400000\n"),
    bash("stat", "\\bstat\\b", "out/final.mp4 8400000 bytes\nout/frames-1/element-00.jpeg 12000 bytes\npublic/voice/scene-01.mp3 48000 bytes\npublic/music/bg.wav 3528444 bytes\n"),
    bash("wc", "\\bwc\\b", "48 src/Root.tsx\n"),
    bash("package-json", "package\\.json", "{\n  \"name\": \"remotion-template\"\n}\n"),
    bashSequence("find", "\\bfind\\b", [`${TEMPLATE_TEXT}\n`, `${PROJECT_TEXT}\n`]),
    bash("frames-ls", "\\bls\\b.*frames-", "element-00.jpeg\nelement-030.jpeg\ncheck.jpeg\n"),
    bashSequence("ls", "\\bls\\b", [`${TEMPLATE_TEXT}\n`, `${PROJECT_TEXT}\n`]),
    bash("ducking-file", "ducking\\.ts", DUCKING_SRC),
    bash("background-file", "BackgroundMusic", BACKGROUND_SRC),
    bash("index-file", "index\\.ts", INDEX_SRC),
    bash("root-file", "Root\\.tsx", ROOT_SRC),
    bash("cat", "\\bcat\\b", ROOT_SRC),
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
          audioPath: "public/voice/probe.mp3",
          timingsPath: "public/voice/probe.words.json",
          voice: "ru-RU-SvetlanaNeural",
          language: "ru-RU",
          format: "mp3",
          durationMs: 500,
          wordCount: 1,
          text: "",
          media: { audioId: "00000000-0000-4000-8000-000000000001" },
        },
      },
    },
    ...[
      ["NOTES\\.md$", "NOTES.md", 8, true],
      ["Root\\.tsx$", "src/Root.tsx", 24, false],
      ["BackgroundMusic", "src/BackgroundMusic.tsx", 12, true],
      ["ducking\\.ts$", "src/ducking.ts", 16, true],
      ["index\\.ts$", "src/index.ts", 4, false],
    ].map(([pattern, path, linesAdded, created], index) => ({
      id: `edit-${index}`,
      tool: "edit_file" as const,
      match: { filePath: { pattern: pattern as string } },
      outcome: {
        response: {
          path,
          created,
          replacements: 1,
          oldContent: "",
          newContent: "",
          linesAdded,
          linesRemoved: 0,
        },
      },
    })),
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
          path: "out/frames-1/element-00.jpeg",
          content: "Кадр 1920x1080: на кадре виден заголовок сцены, поля не обрезаны.",
          totalLines: 1,
          truncated: false,
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
      id: "read-package",
      tool: "read_file",
      match: { filePath: { pattern: "package\\.json$" } },
      outcome: {
        response: {
          path: "package.json",
          content: "{\n  \"name\": \"remotion-template\"\n}\n",
          totalLines: 3,
          truncated: false,
        },
      },
    },
    {
      id: "read-root",
      tool: "read_file",
      match: { filePath: { pattern: "Root\\.tsx$" } },
      outcomes: [
        { response: { path: "src/Root.tsx", content: "export const RemotionRoot = () => null;\n", totalLines: 1, truncated: false } },
        { response: { path: "src/Root.tsx", content: ROOT_SRC, totalLines: 12, truncated: false } },
      ],
    },
    {
      id: "read-voice-dir",
      tool: "read_file",
      match: { filePath: { pattern: "public/voice/?$" } },
      outcome: {
        response: {
          path: "public/voice",
          content: SCENES.map((_, index) => `scene-${String(index + 1).padStart(2, "0")}.mp3`).join("\n") + "\n",
          totalLines: SCENES.length,
          truncated: false,
        },
      },
    },
    {
      id: "read-music-dir",
      tool: "read_file",
      match: { filePath: { pattern: "public/music/?$" } },
      outcome: {
        response: { path: "public/music", content: "bg.wav\n", totalLines: 1, truncated: false },
      },
    },
    {
      id: "read-background",
      tool: "read_file",
      match: { filePath: { pattern: "BackgroundMusic" } },
      outcome: {
        response: { path: "src/BackgroundMusic.tsx", content: BACKGROUND_SRC, totalLines: 8, truncated: false },
      },
    },
    {
      id: "read-ducking",
      tool: "read_file",
      match: { filePath: { pattern: "ducking\\.ts$" } },
      outcome: {
        response: { path: "src/ducking.ts", content: DUCKING_SRC, totalLines: 6, truncated: false },
      },
    },
    {
      id: "read-index",
      tool: "read_file",
      match: { filePath: { pattern: "index\\.ts$" } },
      outcome: {
        response: { path: "src/index.ts", content: INDEX_SRC, totalLines: 5, truncated: false },
      },
    },
    {
      id: "read-remotion-config",
      tool: "read_file",
      match: { filePath: { pattern: "remotion\\.config\\.ts$" } },
      outcome: {
        response: {
          path: "remotion.config.ts",
          content: "import { Config } from \"@remotion/cli/config\";\nConfig.setVideoImageFormat(\"jpeg\");\n",
          totalLines: 2,
          truncated: false,
        },
      },
    },
    {
      id: "read-src-dir",
      tool: "read_file",
      match: { filePath: { pattern: "^/workspace/[^/.]+/src$" } },
      outcome: {
        response: {
          path: "src",
          content: "index.ts\nRoot.tsx\nBackgroundMusic.tsx\nducking.ts\n",
          totalLines: 4,
          truncated: false,
        },
      },
    },
    {
      id: "read-remotion-md",
      tool: "read_file",
      match: { filePath: { pattern: "remotion\\.md$" } },
      outcome: {
        response: {
          path: "references/remotion.md",
          content: "Звук начинается через 10 кадров, после аудио остаётся 0,5 с. Субтитры собираются из words[].\n",
          totalLines: 1,
          truncated: false,
        },
      },
    },
    {
      id: "read-skill",
      tool: "read_file",
      match: { filePath: { pattern: "SKILL\\.md$" } },
      outcome: {
        response: {
          path: "SKILL.md",
          content: "Навык уже загружен в этот ход.\n",
          totalLines: 1,
          truncated: false,
        },
      },
    },
    {
      id: "read-project-dir",
      tool: "read_file",
      match: { filePath: { pattern: "^/workspace/[^/.]+$" } },
      outcome: {
        response: {
          path: "/workspace",
          content: "src\npublic\npackage.json\nNOTES.md\ntsconfig.json\nremotion.config.ts\n",
          totalLines: 6,
          truncated: false,
        },
      },
    },
    {
      id: "read-notes",
      tool: "read_file",
      match: { filePath: { pattern: "NOTES\\.md$" } },
      outcome: {
        response: {
          path: "NOTES.md",
          content: "Формат: 16:9, 1920×1080, 30 к/с\n",
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
          content: ROOT_SRC,
          totalLines: 12,
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
