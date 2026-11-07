import data from "../fixtures/voiceover/project.json";
import { voiceoverFrames } from "./media-fixture";

export const PROJECT = "/workspace/calm-morning";
export const VOICE = "ru-RU-SvetlanaNeural";
export const PIPER_VOICE = "ru_RU-denis-medium";
export const VOICEOVER_TIMEOUT_MS = 30 * 60 * 1000;
export const SCENES = data.scenes.map(({ text }) => text);
export const REVIEW_FRAMES = voiceoverFrames.map(({ number }) => number);
export const FRAME_NAMES = REVIEW_FRAMES.map(
  (number) => `element-${String(number).padStart(3, "0")}.jpeg`,
);
export const framePaths = FRAME_NAMES.map(
  (name) => `${PROJECT}/out/frames-1/${name}`,
);

export function sceneBase(index: number, fallback: boolean, version = "") {
  const number = String(index + 1).padStart(2, "0");
  const suffix = fallback ? "-piper" : "";
  return `${PROJECT}/public/voice/scene-${number}${suffix}${version}`;
}

export function fixtureTimings(index: number, fallback: boolean) {
  return {
    ...data.scenes[index],
    voice: fallback ? `piper:${PIPER_VOICE}` : VOICE,
    format: fallback ? "wav" : "mp3",
  };
}

export function escapePattern(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function readResponse(path: string, text: string) {
  const lines = text.split("\n");
  return {
    path,
    content: lines.map((line, index) => `${index + 1}: ${line}`).join("\n"),
    totalLines: lines.length,
    truncated: false,
  };
}

export function duration(ms: number) {
  return (ms / 1000).toFixed(6);
}
