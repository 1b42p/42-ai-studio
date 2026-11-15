import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { EveEvalContext } from "eve/evals";
import { expect, test, vi } from "vitest";
import { parseToolStubs } from "../../../node_modules/eve/dist/src/tool-stubs/rules.js";
import { StubPlayback } from "../../../node_modules/eve/dist/src/tool-stubs/playback.js";
import type { EditFileResult } from "../../../agent/tools/edit_file";
import { formatEditFileModelOutput } from "../../../lib/edit-file/apply";
import {
  isFinal, questionFrameContracts, questionSession, questionStubs, questionVideoCommand, questionVideoContracts, REQUEST,
} from "../../../evals/questions/fixtures";
import {
  frameDirectory, frameName, frameOutput, questionFrames, questionFramesFor, questionProjectPath,
  questionProps, questionSnapshot, questionSources, reviewFrames, seedQuestionFrames, snapshotBinding,
} from "../../../evals/questions/media-fixture";
import recording from "../../../evals/fixtures/questions/frames.json";

const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const tools = ["bash", "read_file", "edit_file", "agent", "ask_question", "speak", "list_voices",
  "download_video", "read_page", "web_search", "set_session_preview"];
const rules = new Map([30, 120].map(seconds => [seconds, parseToolStubs(questionStubs(seconds))]));

function expectNoFixtureLeak(value: unknown) {
  expect(JSON.stringify(value)).not.toMatch(/номинальн|подмен|фиктивн|не моделиру|не созда(?:ётся|ются|вался|вались)|\b(?:stub|fixture|evals?)\b/iu);
}

function playback(seconds = 120) {
  const player = new StubPlayback(rules.get(seconds)!);
  let nextId = 0;
  const call = (tool: string, input: Record<string, unknown>) => player.call({ callId: `call-${nextId++}`, tool, input });
  const success = (tool: string, input: Record<string, unknown>) => {
    const result = call(tool, input);
    expect(result, JSON.stringify(input)).toMatchObject({ kind: "stub", outcome: { response: expect.anything() } });
    if (result.kind !== "stub" || !("response" in result.outcome)) throw new Error("Нет записанного ответа.");
    return result.outcome.response;
  };
  const rejected = (tool: string, input: Record<string, unknown>) => {
    expect(call(tool, input), JSON.stringify(input)).toMatchObject({ kind: "stub", outcome: { throw: { message: expect.any(String) } } });
  };
  return { call, success, rejected };
}

test.each([30, 120])("%s: JSON правила помещаются в лимит, ASK остаётся настоящим", seconds => {
  const stubs = rules.get(seconds)!;
  expect(stubs).toHaveLength(98);
  expect(stubs.some(stub => stub.tool === "ask_question")).toBe(false);
  const h = playback(seconds);
  expect(h.call("ask_question", { question: "Согласуете?" }).kind).not.toBe("stub");
  for (const tool of tools.filter(name => name !== "ask_question")) {
    expect(stubs.some(stub => stub.tool === tool && stub.match === undefined), tool).toBe(true);
  }
  expect(REQUEST(seconds)).not.toMatch(/ask_question|черновик|согласован|согласуй|больше 60|рендерить финал|после ответа/i);
  expect(REQUEST(seconds)).toContain(questionProjectPath(seconds));
  expect(frameName(seconds, 0)).toBe(seconds === 30 ? "element-000.jpeg" : "element-0000.jpeg");
  expect(frameName(seconds, seconds * 30 - 1)).toBe(seconds === 30 ? "element-899.jpeg" : "element-3599.jpeg");
});

test.each([30, 120])("%s: описание операций не раскрывает подмены, исходные снимки не доказывают запись", seconds => {
  const h = playback(seconds);
  const P = questionProjectPath(seconds);
  const spec = h.success("read_file", { filePath: `${P}/SPEC.md` }) as { content: string };
  expectNoFixtureLeak(REQUEST(seconds));
  expectNoFixtureLeak(spec);
  expect(spec.content).toContain("read_file для preview-v1.jpg и preview-v2.jpg не поддержан");
  expect(spec.content).toContain("Чтение props-v2.json возвращает этот неизменяемый образец, не подтверждение предшествующей записи");
  expect(spec.content).toContain("показывают исходный манифест, не состояние записей");
  const notes = h.success("read_file", { filePath: `${P}/NOTES.md` });
  expectNoFixtureLeak(notes);
  const props = h.success("read_file", { filePath: `${P}/props-v2.json` });
  h.success("edit_file", { filePath: `${P}/props-v2.json`, newString: questionProps(2) });
  expect(h.success("read_file", { filePath: `${P}/props-v2.json` })).toEqual(props);
  h.success("edit_file", { filePath: `${P}/NOTES.md`, newString: "Актуальные заметки", overwrite: true });
  h.rejected("read_file", { filePath: `${P}/NOTES.md` });
  h.rejected("read_file", { filePath: `${P}/NOTES.md` });
  h.rejected("edit_file", { filePath: `${P}/NOTES.md`, oldString: "Кофе", newString: "Утро" });
  for (const stub of rules.get(seconds)!) {
    const outcomes = stub.outcomes ?? (stub.outcome ? [stub.outcome] : []);
    expect(outcomes.length).toBeGreaterThan(0);
    for (const outcome of outcomes) if ("throw" in outcome) expectNoFixtureLeak(outcome.throw);
  }
});

test("манифест связывает настоящие кадры с source, props, номером и JPEG-байтами", () => {
  expect(recording.schemaVersion).toBe(2);
  expect(recording.renderer).toMatchObject({ kind: "react-dom/server+playwright", jpegQuality: 90 });
  expect(questionFrames).toHaveLength(48);
  expect(new Set(questionFrames.map(frame => frame.path)).size).toBe(48);
  for (const seconds of [30, 120]) for (const version of [1, 2] as const) {
    const snapshot = questionSnapshot(seconds, version);
    const frames = questionFrames.filter(frame => frame.seconds === seconds && frame.version === version);
    const sources = questionSources(seconds);
    expect(sources["src/Coffee.tsx"]).toBe(readFileSync("evals/fixtures/questions/Coffee.tsx", "utf8"));
    expect(snapshot.sourceSha256).toBe(hash(JSON.stringify(sources)));
    expect(snapshot.propsSha256).toBe(hash(questionProps(version)));
    expect(snapshot.fingerprint).toBe(hash(JSON.stringify(snapshotBinding(seconds, version, frames))));
    for (const frame of frames) {
      const bytes = Buffer.from(frame.base64, "base64");
      expect(bytes.length).toBe(frame.size);
      expect(hash(bytes)).toBe(frame.sha256);
      expect(bytes.readUInt16BE(0)).toBe(0xffd8);
      expect(bytes.readUInt16BE(bytes.length - 2)).toBe(0xffd9);
      expect(frame.path).toBe(`${questionProjectPath(seconds)}/${frameDirectory(version, frame.pass)}/${frameName(seconds, frame.frame)}`);
      expect(frame.sourceSha256).toBe(snapshot.sourceSha256);
      expect(frame.propsSha256).toBe(snapshot.propsSha256);
      expect(frame.composition).toBe("Main");
      expect(frame.scene).toBe(Math.min(2, Math.floor(frame.frame / (seconds * 10))));
      expect(frame.width).toBe(1920);
      expect(frame.height).toBe(1080);
    }
  }
});

test("проверка происхождения отклоняет повреждённые номер, параметры и пиксели", () => {
  const frame = questionFrames[0];
  const saved = { ...frame };
  for (const change of [{ frame: 1 }, { propsSha256: "wrong" }, { sha256: "wrong" }, { width: 960 }, { base64: "ZmFrZQ==" }, { extrema: [[0, 255], [0, 255], [0, 255]] }]) {
    try {
      Object.assign(frame, change);
      expect(() => questionSnapshot(frame.seconds, frame.version)).toThrow();
    } finally {
      Object.assign(frame, saved);
    }
  }
});

test.each([30, 120])("%s: новый frames-2 с исходными props показывает исходные, а не исправленные пиксели", seconds => {
  const h = playback(seconds);
  const initial = questionFramesFor(seconds, 1, 1);
  const repeated = questionFramesFor(seconds, 1, 2);
  const corrected = questionFramesFor(seconds, 2, 2);
  expect(initial.map(frame => frame.frame)).toEqual(reviewFrames(seconds));
  expect(repeated.map(frame => frame.sha256)).toEqual(initial.map(frame => frame.sha256));
  expect(corrected[0].sha256).not.toBe(initial[0].sha256);
  h.success("bash", { command: `npx remotion render src/index.ts Main out/props-v1/frames-2 --props=props-v1.json --frames=${reviewFrames(seconds).join(",")} --image-format=jpeg --jpeg-quality=90` });
  const report = h.success("bash", { command: 'python3 "$HOME/.agents/skills/frame-review/scripts/check-frames.py" out/props-v1/frames-2/*.jpeg' }) as { stdout: string };
  const rows = report.stdout.split("\n").filter(line => line.startsWith("{")).map(line => JSON.parse(line));
  expect(rows).toEqual(repeated.map(({ path, extrema }) => ({ path, extrema, suspect: null })));
  for (const frame of repeated) expect(h.success("read_file", { filePath: frame.path })).toEqual(frameOutput(frame));
});

test.each([30, 120])("%s: контракты кадров и пикселей совпадают с native playback для всех трёх наборов", seconds => {
  const h = playback(seconds);
  const contracts = questionFrameContracts(seconds);
  expect(contracts.map(({ version, pass }) => [version, pass])).toEqual([[1, 1], [1, 2], [2, 2]]);
  for (const batch of contracts) {
    expect(batch.seconds).toBe(seconds);
    expect(batch.directory).toBe(frameDirectory(batch.version, batch.pass));
    expect(batch.frames).toEqual(questionFramesFor(seconds, batch.version, batch.pass));
    expect(batch.render.source).toBe(new RegExp(batch.renderPattern).source);
    expect(batch.pixels.source).toBe(new RegExp(batch.pixelsPattern).source);
    const render = `cd ${questionProjectPath(seconds)} && npx remotion render src/index.ts Main ${batch.directory} --props=props-v${batch.version}.json --frames=${reviewFrames(seconds).join(",")} --image-format=jpeg --jpeg-quality=90`;
    expect(batch.render.test(render)).toBe(true);
    const rendered = h.success("bash", { command: render });
    expect(rendered).toEqual({
      status: "completed", exitCode: 0, stdout: batch.frames.map(frame => `Rendered ${frame.path}`).join("\n"),
      stderr: "", truncated: false,
    });
    expectNoFixtureLeak(rendered);
    for (const inputs of [`${batch.directory}/*.jpeg`, batch.frames.map(frame => frame.path).join(" ")]) {
      const command = `python3 "$HOME/.agents/skills/frame-review/scripts/check-frames.py" ${inputs}`;
      expect(batch.pixels.test(command)).toBe(true);
      const report = h.success("bash", { command }) as { stdout: string };
      expect(report.stdout.split("\n").filter(line => line.startsWith("{")).map(line => JSON.parse(line)))
        .toEqual(batch.frames.map(({ path, extrema }) => ({ path, extrema, suspect: null })));
    }
    for (const invalid of [
      render.replace(`props-v${batch.version}.json`, `props-v${batch.version === 1 ? 2 : 1}.json`),
      render.replace(batch.directory, "out/frames-99"),
      render.replace(reviewFrames(seconds).join(","), "0,40,80"),
      `${render} && false`, `${render} --unknown=1`,
    ]) {
      expect(batch.render.test(invalid), invalid).toBe(false);
      h.rejected("bash", { command: invalid });
    }
    for (const invalid of [
      `python3 "$HOME/.agents/skills/frame-review/scripts/check-frames.py" ${batch.directory}/element-0040.jpeg`,
      `python3 "$HOME/.agents/skills/frame-review/scripts/check-frames.py" ${batch.directory}/*.jpeg && false`,
    ]) {
      expect(batch.pixels.test(invalid), invalid).toBe(false);
      h.rejected("bash", { command: invalid });
    }
  }
});

test("каждый абсолютный номер имеет свою запись: анимация не заменяется представителем сцены", () => {
  const frames = questionFramesFor(120, 1, 1);
  const start = frames.find(frame => frame.frame === 1200)!;
  const middle = frames.find(frame => frame.frame === 1800)!;
  expect(start.scene).toBe(middle.scene);
  expect(start.sha256).not.toBe(middle.sha256);
  expect(frameOutput(start).path).not.toBe(frameOutput(middle).path);
  const short = questionFramesFor(30, 1, 1).find(frame => frame.frame === 300)!;
  const long = frames.find(frame => frame.frame === 300)!;
  expect(short.scene).toBe(1);
  expect(long.scene).toBe(0);
  expect(short.sha256).not.toBe(long.sha256);
  const h = playback();
  for (const path of [
    "/workspace/calm-morning-120/out/draft-40.jpeg",
    "/workspace/calm-morning-120/out/props-v1/frames-1/draft-40.jpeg",
    "/workspace/calm-morning-120/out/props-v1/frames-1/element-0040.jpeg",
    "/workspace/calm-morning-120/out/frames-2/element-0000.jpeg",
    "/workspace/calm-morning-120/out/props-v2/frames-1/element-0000.jpeg",
    "/workspace/calm-morning-30/out/props-v1/frames-1/element-000.jpeg",
  ]) h.rejected("read_file", { filePath: path });
});

test("несогласованные props, каталоги, выборки, команды и записи отклоняются", () => {
  const h = playback();
  const command = `npx remotion render src/index.ts Main out/props-v2/frames-2 --props=props-v2.json --frames=${reviewFrames(120).join(",")} --image-format=jpeg --jpeg-quality=90`;
  h.success("bash", { command });
  for (const invalid of [
    command.replace("--props=props-v2", "--props=props-v1"),
    command.replace("out/props-v2", "out/props-v1"),
    command.replace("frames-2", "frames-3"),
    command.replace(reviewFrames(120).join(","), "0,40,80"),
    command.replace("90", "80"), `${command} && false`, `${command}; echo ok`,
    `echo '${command}'`, `${command}\nfalse`, `${command} --props=props-v1.json`,
    "npx remotion ffmpeg -i out/coffee-v1-draft.mp4 out/draft-%d.jpeg",
    "touch out/props-v2/frames-2/fake.jpeg", "ls /workspace/other", "test -s /workspace/other.mp4",
  ]) h.rejected("bash", { command: invalid });
  const destination = `${questionProjectPath(120)}/props-v2.json`;
  const exact = questionProps(2);
  expect(h.success("edit_file", { filePath: destination, newString: exact })).toMatchObject({ path: destination, newContent: exact });
  const notesResult = h.success("edit_file", {
    filePath: `${questionProjectPath(120)}/NOTES.md`, newString: "Обновлённые заметки", overwrite: true,
  }) as unknown as EditFileResult;
  expect(notesResult).toEqual({
    path: `${questionProjectPath(120)}/NOTES.md`, created: false, replacements: 0,
    oldContent: expect.any(String), newContent: expect.any(String),
    linesAdded: expect.any(Number), linesRemoved: expect.any(Number),
  });
  expectNoFixtureLeak(formatEditFileModelOutput(notesResult));
  h.rejected("edit_file", { filePath: `${questionProjectPath(120)}/NOTES.md`, newString: "Обновлённые заметки" });
  const pixelCommand = `python3 "$HOME/.agents/skills/frame-review/scripts/check-frames.py" out/props-v1/frames-1/*.jpeg`;
  h.success("bash", { command: pixelCommand });
  h.rejected("bash", { command: pixelCommand.replaceAll('"', "'") });
  for (const input of [
    { filePath: destination, newString: questionProps(1) },
    { filePath: destination, newString: '{"title":"Другой заголовок"}' },
    { filePath: destination, newString: exact, oldString: "старый текст" },
    { filePath: destination.replace("v2", "v3"), newString: exact },
    { filePath: `${questionProjectPath(120)}/src/Root.tsx`, newString: "изменённый код" },
  ]) h.rejected("edit_file", input);
});

test.each([30, 120])("%s: экспорт видео узнаёт ровно те же команды, что и native playback", seconds => {
  const h = playback(seconds);
  const contracts = questionVideoContracts(seconds);
  expect(contracts).toHaveLength(4);
  for (const video of contracts) {
    const P = questionProjectPath(seconds);
    const render = `cd ${P} && npx remotion render "${P}/src/index.ts" Main "${video.path}" --props "${P}/props-v${video.version}.json" --codec=h264 --concurrency 2 --log=error --overwrite${video.draft ? " --crf 32 --scale 0.5 --x264-preset superfast" : ""}`;
    const commands = {
      render,
      size: `stat -c%s '${video.path}'`,
      nonempty: `test -s ${video.relativePath}`,
      probe: `npx remotion ffprobe -show_format -of json -v error -show_streams ${video.relativePath}`,
      probeFields: `npx remotion ffprobe -v error -show_entries stream=codec_name,codec_type,width,height,duration:format=duration -of default=nw=1 ${video.path}`,
    };
    for (const [operation, command] of Object.entries(commands)) {
      const match = questionVideoCommand(seconds, command);
      expect(match?.operation).toBe(operation);
      expect(match?.video).toEqual(video);
      const output = h.success("bash", { command }) as { stdout: string; exitCode: number };
      expect(output).toMatchObject({ status: "completed", exitCode: 0, stdout: expect.any(String), stderr: "", truncated: false });
      expectNoFixtureLeak(output);
      if (operation === "render") expect(output.stdout).toBe(`Rendered ${video.path}`);
      if (operation === "size") expect(Number(output.stdout)).toBe(video.sizeBytes);
      if (operation === "probe") expect(JSON.parse(output.stdout)).toEqual(video.metadata);
      if (operation === "probeFields") expect(output.stdout).toBe(video.probeFields);
      const adapter = operation === "probeFields" ? video.probe : video[operation as "render" | "size" | "nonempty" | "probe"];
      expect(adapter.test(command)).toBe(true);
    }
    for (const invalid of [
      render.replace(`props-v${video.version}.json`, `props-v${video.version === 1 ? 2 : 1}.json`),
      render.replace("src/index.ts", "src/Root.tsx"),
      `${render} --bogus=1`, `${render} && false`, `${render} --props=other.json`,
      video.draft ? render.replace("superfast", "medium") : `${render} --scale=0.5`,
      commands.probe.replace(video.relativePath, "out/no-such.mp4"),
      commands.size.replace(video.path, "/workspace/no-such.mp4"),
    ]) {
      expect(questionVideoCommand(seconds, invalid), invalid).toBeNull();
      h.rejected("bash", { command: invalid });
    }
    if (!video.draft) {
      for (const flags of ["--crf=18 --x264-preset=medium", "--scale=1 --muted", "--crf=0 --x264-preset=slow"]) {
        h.success("bash", { command: `${render} ${flags}` });
        expect(video.render.test(`${render} ${flags}`)).toBe(true);
        expect(isFinal(`${render} ${flags}`)).toBe(true);
      }
      h.rejected("bash", { command: `${render} --crf=52` });
    }
  }
});

test.each([30, 120])("%s: still и публикация возвращают успешные ответы без подставных пикселей или решения о согласии", seconds => {
  const h = playback(seconds);
  const P = questionProjectPath(seconds);
  const spec = h.success("read_file", { filePath: `${P}/SPEC.md` }) as { content: string };
  expectNoFixtureLeak(spec);
  for (const video of questionVideoContracts(seconds).filter(video => !video.draft)) {
    expect(video.previewPath).toBe(`${P}/out/preview-v${video.version}.jpg`);
    expect(questionFrames.some(frame => frame.path === video.previewPath)).toBe(false);
    // Fixed capabilities do not know whether consent or a final render happened;
    // the causal business gates must reject premature calls, not these stubs.
    expect(h.success("set_session_preview", { path: video.previewPath })).toEqual({
      path: video.previewPath, size: video.previewSizeBytes, contentType: "image/jpeg",
    });
    for (const frame of reviewFrames(seconds)) {
      const command = `cd ${P} && npx remotion still ${P}/src/index.ts Main ${video.previewPath} --props=${P}/props-v${video.version}.json --frame=${frame} --image-format=jpeg --jpeg-quality=85 --scale=0.5`;
      expect(video.stillRegExp.test(command)).toBe(true);
      const output = h.success("bash", { command }) as { stdout: string };
      expect(output).toEqual({ status: "completed", exitCode: 0, stdout: `Rendered ${video.previewPath}`, stderr: "", truncated: false });
      expectNoFixtureLeak(output);
      const reordered = `remotion still src/index.ts Main '${video.previewRelativePath}' --scale 0.5 --jpeg-quality 85 --image-format jpeg --frame ${frame} --props props-v${video.version}.json`;
      expect(video.stillRegExp.test(reordered)).toBe(true);
      h.success("bash", { command: reordered });
      for (const invalid of [
        command.replace(`props-v${video.version}.json`, `props-v${video.version === 1 ? 2 : 1}.json`),
        command.replace(`preview-v${video.version}.jpg`, `preview-v${video.version === 1 ? 2 : 1}.jpg`),
        command.replace("src/index.ts", "src/Root.tsx"),
        command.replace("--image-format=jpeg", "--image-format=png"),
        command.replace("--jpeg-quality=85", "--jpeg-quality=90"),
        command.replace("--scale=0.5", "--scale=1"),
        command.replace(`--frame=${frame}`, `--frame=${seconds * 30}`),
        `${command} --frame=0`, `${command} --unknown=1`, `${command} && false`,
      ]) {
        expect(video.stillRegExp.test(invalid), invalid).toBe(false);
        h.rejected("bash", { command: invalid });
      }
    }
    for (const frame of [1, 40, seconds * 25, seconds * 30 - 2]) {
      h.success("bash", { command: `npx remotion still src/index.ts Main ${video.previewRelativePath} --props=props-v${video.version}.json --frame=${frame} --image-format=jpeg --jpeg-quality=85 --scale=0.5` });
    }
    h.success("set_session_preview", { path: `calm-morning-${seconds}/${video.previewRelativePath}` });
    h.rejected("read_file", { filePath: video.previewPath });
    h.rejected("read_file", { filePath: `calm-morning-${seconds}/${video.previewRelativePath}` });
    h.rejected("bash", { command: `test -s ${video.previewPath}` });
  }
  for (const path of [
    `${P}/out/preview-v3.jpg`, `${P}/out/preview-v1.png`, `${P}/out/preview.jpg`,
    `/workspace/other/out/preview-v1.jpg`,
  ]) h.rejected("set_session_preview", { path });
});

test("seed-compatible пути передают toModelOutput именно записанные JPEG", async () => {
  const root = "../../../node_modules/eve/dist/src";
  const { contextStorage, ContextContainer } = await import(`${root}/context/container.js`);
  const { SandboxKey } = await import(`${root}/context/keys.js`);
  const { readFile } = await import(`${root}/tools/provided/read-file.js`);
  const files = new Map([[questionFrames[0].path, Buffer.from("stale cached pixels")]]);
  await seedQuestionFrames({
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
    for (const frame of questionFrames) {
      const projected = await readFile.toModelOutput(frameOutput(frame));
      expect(projected.type).toBe("content");
      const image = projected.value.find((part: { type: string }) => part.type === "file");
      expect(image.data.data).toBe(frame.base64);
      expect(image.mediaType).toBe("image/jpeg");
    }
  });
});

function isolated(extra: string[] = [], dynamic: unknown[] = []) {
  const session = vi.fn(async () => ({ sessionId: "unit-question" }));
  const context = { target: { fetch: async (path: string) => path === "/api/health"
    ? new Response(null, { headers: { "x-studio-eval-runtime": "stub" } })
    : Response.json({ tools: { static: [...tools, ...extra].map(name => ({ name })), dynamic } }) }, session } as unknown as EveEvalContext;
  return { context, session };
}

test("questionSession сохраняет native ASK и не создаёт сессию с неизвестными эффектами", async () => {
  const valid = isolated();
  await questionSession(valid.context);
  expect(valid.session).toHaveBeenCalledTimes(1);
  for (const [extra, dynamic] of [[["new_effect"], []], [[], [{ name: "dynamic_effect" }]]] as [string[], unknown[]][]) {
    const h = isolated(extra, dynamic);
    await expect(questionSession(h.context)).rejects.toThrow("Неподменённые эффекты");
    expect(h.session).not.toHaveBeenCalled();
  }
});
