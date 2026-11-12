import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import { imageOutput, knownImage, previewFrames, seedPreviewFrames } from "../../../evals/preview/media-fixture";
import integration from "../../../evals/fixtures/preview/integration.json";

test("для каждой длительности есть шесть настоящих JPEG трёх сцен и шесть уменьшенных кадров на выбор", () => {
  for (const seconds of [30, 120]) {
    const frames = previewFrames.filter(frame => frame.seconds === seconds);
    expect(frames.filter(frame => frame.width === 1920)).toHaveLength(6);
    expect(frames.filter(frame => frame.width === 960)).toHaveLength(6);
    expect(new Set(frames.map(frame => frame.sha256)).size).toBe(6);
    for (const frame of frames) {
      const bytes = Buffer.from(frame.base64, "base64");
      expect(bytes.readUInt16BE(0)).toBe(0xffd8);
      expect(bytes.length).toBe(frame.size);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(frame.sha256);
    }
  }
});

test("все разрешённые MP4 имеют запись рендера, согласованные размер, длительность и разрешение", () => {
  expect(integration.videos.map(video => [video.seconds, video.draft])).toEqual([[30, false], [30, true], [120, false], [120, true]]);
  for (const video of integration.videos) {
    expect(video.renderOptions).toEqual({ codec: "h264", scale: video.draft ? 0.5 : 1, concurrency: 2,
      ...(video.draft ? { x264Preset: "superfast", crf: 32 } : {}) });
    expect(video.size).toBeGreaterThan(0);
    expect(video.probe.format).toMatchObject({ filename: video.path, size: String(video.size), duration: `${video.seconds}.000000` });
    expect(video.probe.streams).toHaveLength(1);
    expect(video.probe.streams[0]).toMatchObject({ codec_name: "h264", codec_type: "video", width: video.draft ? 960 : 1920, height: video.draft ? 540 : 1080, r_frame_rate: "30/1", nb_frames: String(video.seconds * 30), duration: `${video.seconds}.000000` });
  }
});

test("seed и штатный toModelOutput передают модели точные JPEG, а не текст вместо картинки", async () => {
  const root = "../../../node_modules/eve/dist/src";
  const { contextStorage, ContextContainer } = await import(`${root}/context/container.js`);
  const { SandboxKey } = await import(`${root}/context/keys.js`);
  const { readFile } = await import(`${root}/tools/provided/read-file.js`);
  const files = new Map<string, Uint8Array>();
  await seedPreviewFrames({
    async mkdir() {},
    async writeFile(path, bytes) { files.set(path, Buffer.from(bytes)); },
    async readFileBuffer(path) { return files.get(path)!; },
  });
  const context = new ContextContainer();
  context.set(SandboxKey, { get: async () => ({
    resolvePath: (path: string) => path,
    readBinaryFile: async ({ path }: { path: string }) => files.get(path) ?? null,
  }) });
  await contextStorage.run(context, async () => {
    for (const frame of previewFrames) {
      const output = imageOutput(frame);
      expect(knownImage(output, frame.path)).toBe(true);
      const projected = await readFile.toModelOutput(output);
      expect(projected.type).toBe("content");
      const image = projected.value.find((part: { type: string }) => part.type === "file");
      expect(image.data.data).toBe(frame.base64);
      expect(image.mediaType).toBe("image/jpeg");
    }
    const first = previewFrames[0];
    files.delete(first.path);
    expect((await readFile.toModelOutput(imageOutput(first))).type).toBe("text");
    expect(knownImage({ ...imageOutput(first), content: "Кадр красивый" }, first.path)).toBe(false);
  });
});
