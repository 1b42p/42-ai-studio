import type { EveEvalContext, ToolStub } from "eve/evals";
import { blockedRead, emptySearch, webSession } from "../web/fixtures";

export const MUSIC_PROJECT = "/workspace/calm-bed";
export const MUSIC_PATH = `${MUSIC_PROJECT}/public/music/bg.wav`;
export const MUSIC_TIMEOUT_MS = 30 * 60 * 1000;

const MUSIC_JSON = JSON.stringify({
  audioPath: MUSIC_PATH,
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

function bash(id: string, pattern: string, stdout: string, stderr = ""): ToolStub {
  return {
    id,
    tool: "bash",
    match: { command: { pattern } },
    outcome: { response: { status: "completed", exitCode: 0, stdout, stderr, truncated: false } },
  };
}

const words = [
  "{",
  "  \"version\": 1,",
  "  \"sentences\": [{ \"text\": \"Спокойное утро\", \"startMs\": 0, \"endMs\": 4000 }]",
  "}",
].join("\n");

export async function musicSession(t: EveEvalContext) {
  return webSession(t, [
    bash("make-music", "make_music\\.py", `${MUSIC_JSON}\n`),
    bash("loudnorm", "loudnorm", LOUDNORM, LOUDNORM),
    bash("ffprobe", "ffprobe", "20000\n"),
    bash("ls", "(^|[;&|]\\s*)ls(\\s|$)", [
      "NOTES.md",
      "public/music/bg.wav",
      "public/voice/scene-01.mp3",
      "public/voice/scene-01.words.json",
      "src/Root.tsx",
      "out/calm-bed.mp4",
    ].join("\n")),
    {
      id: "words",
      tool: "read_file",
      match: { filePath: { pattern: "\\.words\\.json$" } },
      outcome: {
        response: {
          path: `${MUSIC_PROJECT}/public/voice/scene-01.words.json`,
          content: words,
          totalLines: 3,
          truncated: false,
        },
      },
    },
    {
      id: "frame",
      tool: "read_file",
      match: { filePath: { pattern: "\\.(jpe?g|png)$" } },
      outcome: {
        response: {
          path: `${MUSIC_PROJECT}/out/frames-1/element-001.jpeg`,
          content: "Image 1920x1080",
          totalLines: 1,
          truncated: false,
          file: { mediaType: "image/jpeg", width: 1920, height: 1080, size: 12000 },
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
