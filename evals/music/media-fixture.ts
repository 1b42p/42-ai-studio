import { createHash } from "node:crypto";
import { dirname } from "node:path";
import type { JustBashFilesystem } from "eve/sandbox/just-bash";

import data from "../fixtures/music/frames.json";
import project from "../fixtures/music/project.json";
import integration from "../fixtures/music/integration.json";

const sha256 = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");

if (data.rootSha256 !== project.rootSha256 || data.sourceSha256 !== project.sourceSha256 ||
  Object.entries(project.sourceHashes).some(([path, expected]) => sha256((project.files as Record<string, string>)[path]) !== expected) ||
  sha256(JSON.stringify(project.sourceHashes)) !== project.sourceSha256) {
  throw new Error("Исходник music-bed не соответствует отрендерённым кадрам.");
}
const measured = integration.measurements;
if (integration.sourceSha256 !== project.sourceSha256 ||
  Math.abs(Number(measured.voiceFull.input_i) + 16) > 2 ||
  Number(measured.voiceSpeech.input_i) - Number(measured.musicSpeech.input_i) < 8 ||
  Math.abs(Number(measured.musicOutside.input_i) + 18) > 2 || Number(measured.mix.input_tp) > -1) {
  throw new Error("Аудит реальных аудиомаршрутов не подтверждает текущий эталон music-bed.");
}

export const musicFrames = data.frames.map((frame) => {
  const bytes = Buffer.from(frame.base64, "base64");
  if (bytes.length !== frame.size || sha256(bytes) !== frame.sha256 || bytes.readUInt16BE(0) !== 0xffd8) {
    throw new Error(`Повреждён кадр music-bed: ${frame.path}`);
  }
  return frame;
});

export const musicFrameOutputs = musicFrames.map((frame) => ({
  path: frame.path,
  content: `Image ${frame.width}x${frame.height}`,
  totalLines: 1,
  truncated: false,
  file: { mediaType: "image/jpeg", width: frame.width, height: frame.height, size: frame.size },
}));

/** Только известные пиксели с точными метаданными; текстовые заглушки не являются просмотром. */
export function isMusicFrameOutput(output: Record<string, unknown>): boolean {
  const expected = musicFrameOutputs.find((frame) => frame.path === output.path);
  if (!expected || output.content !== expected.content || output.truncated !== false) return false;
  const file = output.file;
  if (typeof file !== "object" || file === null) return false;
  const metadata = file as Record<string, unknown>;
  return Object.entries(expected.file).every(([key, value]) => metadata[key] === value);
}

/** Все инструменты оценки подменены, поэтому после открытия песочницы эти байты неизменны. */
export async function seedMusicFrames(filesystem: Pick<JustBashFilesystem, "mkdir" | "writeFile" | "readFileBuffer">): Promise<void> {
  for (const frame of musicFrames) {
    await filesystem.mkdir(dirname(frame.path), { recursive: true });
    // Перезаписываем старую фикстуру при повторном открытии durable-песочницы.
    await filesystem.writeFile(frame.path, Buffer.from(frame.base64, "base64"));
    const stored = await filesystem.readFileBuffer(frame.path);
    if (stored.byteLength !== frame.size || sha256(stored) !== frame.sha256) {
      throw new Error(`Песочница music-bed не сохранила пиксели: ${frame.path}`);
    }
  }
}
