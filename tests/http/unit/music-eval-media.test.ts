import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import {
  isMusicFrameOutput,
  musicFrameOutputs,
  musicFrames,
  seedMusicFrames,
} from "../../../evals/music/media-fixture";
import { MUSIC_FRAMES, MUSIC_SCENES, musicWordsFile } from "../../../evals/music/fixtures";
import project from "../../../evals/fixtures/music/project.json";

test("шесть JPEG содержат реальные пиксели четырёх сцен и соответствуют исходнику", () => {
  expect(musicFrames.map((frame) => frame.number)).toEqual(MUSIC_FRAMES);
  expect(new Set(musicFrames.map((frame) => frame.sha256)).size).toBeGreaterThanOrEqual(4);
  for (const frame of musicFrames) {
    const bytes = Buffer.from(frame.base64, "base64");
    expect(bytes.length).toBe(frame.size);
    expect(bytes.length).toBeGreaterThan(10_000);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(frame.sha256);
    expect([frame.width, frame.height]).toEqual([1920, 1080]);
  }
  expect(createHash("sha256").update(project.files["src/Root.tsx"]).digest("hex")).toBe(project.rootSha256);
  MUSIC_SCENES.forEach((scene, index) => {
    const path = `public/voice/scene-${String(index + 1).padStart(2, "0")}.words.json` as keyof typeof project.files;
    expect(project.files[path]).toBe(musicWordsFile(index));
    expect(Math.ceil(10 + scene.durationMs / 1000 * project.fps + 0.5 * project.fps)).toBe(150);
  });
});

test("seed кладёт точные байты, включая замену старых файлов", async () => {
  const files = new Map(musicFrames.map((frame) => [frame.path, Buffer.from("old fixture")]));
  const filesystem = {
    async mkdir() {},
    async writeFile(path: string, bytes: string | Uint8Array) { files.set(path, Buffer.from(bytes)); },
    async readFileBuffer(path: string) { return files.get(path)!; },
  };
  await seedMusicFrames(filesystem);
  for (const frame of musicFrames) expect(files.get(frame.path)).toEqual(Buffer.from(frame.base64, "base64"));
});

test("ошибка сохранения пикселей не позволяет открыть якобы готовую песочницу", async () => {
  await expect(seedMusicFrames({
    async mkdir() {},
    async writeFile() {},
    async readFileBuffer() { return new Uint8Array(); },
  })).rejects.toThrow("не сохранила пиксели");
});

test("описание картинки, несовпавший размер и недоступное медиа не считаются просмотром", () => {
  const output = musicFrameOutputs[0];
  expect(isMusicFrameOutput(output)).toBe(true);
  expect(isMusicFrameOutput({ ...output, file: undefined })).toBe(false);
  expect(isMusicFrameOutput({ ...output, file: { ...output.file, size: 12000 } })).toBe(false);
  expect(isMusicFrameOutput({ ...output, content: "The file could not be loaded." })).toBe(false);
  expect(isMusicFrameOutput({ ...output, path: "/workspace/missing.jpeg" })).toBe(false);
});

test("штатный read_file передаёт модели настоящие JPEG и не подменяет недоступное медиа картинкой", async () => {
  const root = "../../../node_modules/eve/dist/src";
  const { contextStorage, ContextContainer } = await import(`${root}/context/container.js`);
  const { SandboxKey } = await import(`${root}/context/keys.js`);
  const { readFile } = await import(`${root}/tools/provided/read-file.js`);
  const files = new Map<string, Uint8Array>();
  await seedMusicFrames({
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
    for (const [index, output] of musicFrameOutputs.entries()) {
      const projected = await readFile.toModelOutput(output);
      expect(projected.type).toBe("content");
      const image = projected.value.find((part: { type: string }) => part.type === "file");
      expect(image.mediaType).toBe("image/jpeg");
      expect(image.data.data).toBe(musicFrames[index].base64);
    }
    files.delete(musicFrameOutputs[0].path);
    const projected = await readFile.toModelOutput(musicFrameOutputs[0]);
    expect(projected.type).toBe("text");
    expect(projected.value).toMatch(/could not be loaded/u);
  });
});
