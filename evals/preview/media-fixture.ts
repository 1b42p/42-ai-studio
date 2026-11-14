import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { JustBashFilesystem } from "eve/sandbox/just-bash";
import data from "../fixtures/preview/frames.json";
import integration from "../fixtures/preview/integration.json";
import { frameName, frameNumbers, projectPath } from "./commands";
import { frameSnapshotRefs, projectProps } from "./project-fixture";

const sha256 = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
if (sha256(readFileSync("evals/fixtures/preview/index.tsx")) !== data.sourceSha256) throw new Error("Исходник preview изменён после записи JPEG.");
if (integration.sourceSha256 !== data.sourceSha256) throw new Error("Метаданные MP4 относятся к другому исходнику preview.");
export const previewFrames = [...data.frames, ...data.previews].map(frame => {
  const bytes = Buffer.from(frame.base64, "base64");
  if (bytes.length !== frame.size || sha256(bytes) !== frame.sha256 || bytes.readUInt16BE(0) !== 0xffd8) throw new Error(`Повреждён эталон ${frame.path}`);
  return frame;
});

/** The initial JPEGs are current, not yet pixel-checked or visually reviewed. */
export function currentReviewFrames(seconds: number) {
  const snapshot = frameSnapshotRefs.find(snapshot => snapshot.seconds === seconds);
  const frames = data.frames.filter(frame => frame.seconds === seconds);
  const expectedPaths = frameNumbers(seconds).map(frame => `${projectPath(seconds)}/out/frames-1/${frameName(frame)}`);
  const propsSha256 = sha256(projectProps(seconds));
  const binding = { sourceSha256: data.sourceSha256, composition: "Main", propsSha256,
    frames: frames.map(({ frame, path, sha256 }) => ({ frame, path, sha256 })) };
  if (!snapshot || snapshot.propsSha256 !== propsSha256 || snapshot.fingerprint !== sha256(JSON.stringify(binding)) ||
    frames.length !== expectedPaths.length || frames.some((frame, index) => frame.path !== expectedPaths[index] || frame.width !== 1920 || frame.height !== 1080)) {
    throw new Error(`Исходник, props и JPEG выборки ${seconds} секунд больше не соответствуют записанному снимку.`);
  }
  return frames;
}
export const imageOutput = (frame: typeof previewFrames[number]) => ({
  path: frame.path, content: `Image ${frame.width}x${frame.height}`, totalLines: 1, truncated: false,
  file: { mediaType: "image/jpeg", width: frame.width, height: frame.height, size: frame.size },
});
export function knownImage(output: unknown, path: string): boolean {
  const frame = previewFrames.find(frame => frame.path === path);
  if (!frame || output === null || typeof output !== "object") return false;
  const actual = output as Record<string, unknown>;
  const expected = imageOutput(frame);
  return actual.path === path && actual.content === expected.content && actual.truncated === false &&
    actual.file !== null && typeof actual.file === "object" &&
    Object.entries(expected.file).every(([key, value]) => (actual.file as Record<string, unknown>)[key] === value);
}
export async function seedPreviewFrames(filesystem: Pick<JustBashFilesystem, "mkdir" | "writeFile" | "readFileBuffer">) {
  for (const frame of previewFrames) {
    await filesystem.mkdir(dirname(frame.path), { recursive: true });
    await filesystem.writeFile(frame.path, Buffer.from(frame.base64, "base64"));
    if (sha256(await filesystem.readFileBuffer(frame.path)) !== frame.sha256) throw new Error(`Не сохранены пиксели ${frame.path}`);
  }
}
