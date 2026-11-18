import { execFileSync } from "node:child_process";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { ExampleVideo } from "../lib/examples";
import { loadConfig } from "../lib/config";

const root = fileURLToPath(new URL("../", import.meta.url));
const manifestPath = path.join(root, "lib/examples.json");
const manifest: ExampleVideo[] = JSON.parse(await readFile(manifestPath, "utf8"));
const { ffprobePath } = loadConfig();

for (const example of manifest) {
  if (!/^\/examples\/[\w-]+-v\d+\.mp4$/.test(example.video)) {
    throw new Error(`Некорректный путь видео: ${example.video}`);
  }
  const file = path.join(root, "public", example.video);
  const result = JSON.parse(execFileSync(ffprobePath, [
    "-v", "error", "-show_streams", "-show_format", "-of", "json", file,
  ], { encoding: "utf8" })) as {
    streams: { codec_type: string; width?: number; height?: number }[];
    format: { duration: string };
  };
  const video = result.streams.find(({ codec_type }) => codec_type === "video");
  const duration = Number(result.format.duration);
  if (!video?.width || !video.height || !Number.isFinite(duration) || duration <= 0) {
    throw new Error(`Не удалось прочитать размеры и длительность: ${example.video}`);
  }
  example.width = video.width;
  example.height = video.height;
  example.durationSec = duration;
  example.bytes = (await stat(file)).size;
}

await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Обновлены метаданные примеров: ${manifest.length}`);
