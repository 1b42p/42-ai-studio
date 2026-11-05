import { Client, type ClientSession } from "eve/client";
import { afterAll, afterEach, beforeAll, expect, test } from "vitest";

import { loadConfig } from "../../lib/config";
import { startApp, type AppHandle } from "./support/app";
import { createUser } from "./support/db";
import { loginAs } from "./support/auth";
import { startEveDev, type EveDevServer } from "./support/eve-dev";
import { videoEvalArtifacts, videoEvalRenderResults } from "../../lib/video-eval/receipts";

const sessions: ClientSession[] = [];
const modes = new WeakMap<ClientSession, string>();
let app: AppHandle;
let eve: EveDevServer;
let client: Client;
beforeAll(async () => {
  eve = await startEveDev({ APP_VIDEO_EVAL_SANDBOX: "1", EVE_DEV_STATE_DIR: `.tmp/eve-video-eval-${process.pid}` });
  app = await startApp({ env: { APP_VIDEO_EVAL_SANDBOX: "1", EVE_BASE_URL: eve.url } });
  client = new Client({ host: app.url, auth: { bearer: loadConfig().eveEvalAuthToken! }, redirect: "manual" });
  // Eve prepares the Docker template on first sandbox access, not on listening.
  const warmup = await session("render-failure");
  try {
    expect(await tool(warmup, "bash", { command: "python3 -c 'import PIL; print(PIL.__version__)'" })).toMatchObject({
      status: "completed", result: { output: { exitCode: 0, stdout: expect.stringContaining("13.0.0") } },
    });
  } finally {
    await warmup.reset();
    sessions.splice(sessions.indexOf(warmup), 1);
  }
}, 240_000);
afterAll(async () => { await app?.stop(); await eve?.stop(); });

afterEach(async () => {
  await Promise.allSettled(sessions.splice(0).map((session) => session.reset()));
});

async function session(mode = "standard") {
  const created = await client.sessions.create({ headers: { "x-studio-video-eval": mode } });
  sessions.push(created.session);
  modes.set(created.session, mode);
  return created.session;
}

async function tool(target: ClientSession, name: string, input: object) {
  const result = await (await target.send(`/tool ${name} ${JSON.stringify(input)}`, {
    headers: { "x-studio-video-eval": modes.get(target) ?? "standard" },
  })).result();
  expect(result.status).toBe("waiting");
  const event = result.events.find((item) => item.type === "action.result" &&
    item.data.result.kind === "tool-result" && item.data.result.toolName === name);
  if (event?.type !== "action.result" || event.data.result.kind !== "tool-result") {
    throw new Error(`Нет результата ${name}`);
  }
  return event.data;
}

const CREATE_PROJECT = "cp -r /opt/remotion/src /workspace/src && cp /opt/remotion/package.json /opt/remotion/tsconfig.json /opt/remotion/remotion.config.ts /workspace/ && ln -s /opt/remotion/node_modules /workspace/node_modules";

test("кадры: предварительная проверка находит пустой JPEG без модели и кодировщика", async () => {
  const target = await session("render-failure");
  const fixture = "from PIL import Image; Image.new('RGB', (64, 64), (30, 12, 6)).save('/workspace/blank.jpeg')";
  expect(await tool(target, "bash", { command: `python3 -c ${JSON.stringify(fixture)}` })).toMatchObject({
    status: "completed", result: { output: { exitCode: 0 } },
  });
  const checked = await tool(target, "bash", {
    command: 'python3 "$HOME/.agents/skills/frame-review/scripts/check-frames.py" /workspace/blank.jpeg',
  });
  expect(checked).toMatchObject({ status: "completed", result: { output: {
    exitCode: 1, stdout: expect.stringContaining("Исправьте композицию"),
  } } });
  expect(checked.result.output).toMatchObject({ stdout: expect.stringContaining('"suspect": "uniform"') });
}, 60_000);

test("оценки видео: чтение после правки видит новое содержимое, bash читает тот же файл", async () => {
  const target = await session();
  const filePath = "/workspace/project/notes.txt";
  expect(await tool(target, "edit_file", { filePath, newString: "Первый текст" })).toMatchObject({
    status: "completed", result: { output: { path: filePath, created: true } },
  });
  expect(await tool(target, "read_file", { filePath })).toMatchObject({
    status: "completed", result: { output: { path: filePath, content: "1: Первый текст" } },
  });
  expect(await tool(target, "edit_file", { filePath, oldString: "Первый", newString: "Изменённый" })).toMatchObject({
    status: "completed", result: { output: { newContent: "Изменённый текст", replacements: 1 } },
  });
  expect(await tool(target, "read_file", { filePath })).toMatchObject({
    status: "completed", result: { output: { path: filePath, content: "1: Изменённый текст" } },
  });
  expect(await tool(target, "bash", { command: `cat ${filePath}; echo '\nMARKER'` })).toMatchObject({
    status: "completed", result: { output: { exitCode: 0, stdout: "Изменённый текст\nMARKER\n" } },
  });
}, 90_000);

test("оценки видео: неизвестные файлы и команды не получают выдуманный успех, сессии изолированы", async () => {
  const first = await session();
  await tool(first, "edit_file", { filePath: "/workspace/private.txt", newString: "Только первая сессия" });
  const second = await session();
  expect(await tool(second, "read_file", { filePath: "/workspace/private.txt" })).toMatchObject({ status: "failed" });
  expect(await tool(second, "bash", { command: "command_that_does_not_exist_42" })).toMatchObject({
    status: "completed", result: { output: { exitCode: 127 } },
  });
  expect(await tool(second, "bash", { command: "echo marker" })).toMatchObject({
    status: "completed", result: { output: { exitCode: 0, stdout: "marker\n" } },
  });
  expect(await tool(second, "bash", { command: "node --version && npm --version && npx --version" })).toMatchObject({
    status: "completed", result: { output: { exitCode: 0, stdout: expect.stringMatching(/^v24\./) } },
  });
  expect(await tool(second, "read_file", { filePath: "$HOME/.agents/skills/remotion-create/video-layout.md" })).toMatchObject({
    status: "completed", result: { output: { content: expect.stringContaining("You are designing a video, not a webpage.") } },
  });
}, 60_000);

test("кадры: предварительная проверка различает тёмное содержимое, пустые и нечитаемые файлы", async () => {
  const target = await session("render-failure");
  const fixtures = `from pathlib import Path
from PIL import Image, ImageDraw
for name, color in [('black', (0,0,0)), ('white', (255,255,255)), ('color', (70,30,10))]:
    Image.new('RGB', (64,64), color).save('/workspace/' + name + '.jpeg')
for name, color in [('dark', (100,110,120)), ('near-black', (4,4,4))]:
    image = Image.new('RGB', (64,64), (0,0,0))
    ImageDraw.Draw(image).rectangle((16,16,48,48), fill=color)
    image.save('/workspace/' + name + '.jpeg', quality=100)
Path('/workspace/corrupt.jpeg').write_bytes(b'not an image')
Path('/workspace/empty').mkdir()
`;
  expect(await tool(target, "edit_file", { filePath: "/workspace/fixtures.py", newString: fixtures })).toMatchObject({ status: "completed" });
  expect(await tool(target, "bash", { command: "python3 /workspace/fixtures.py" })).toMatchObject({
    status: "completed", result: { output: { exitCode: 0 } },
  });
  const script = 'python3 "$HOME/.agents/skills/frame-review/scripts/check-frames.py"';
  for (const name of ["black", "white", "color", "near-black"]) {
    const checked = await tool(target, "bash", { command: `${script} /workspace/${name}.jpeg` });
    expect(checked).toMatchObject({ status: "completed", result: { output: { exitCode: 1 } } });
  }
  const valid = await tool(target, "bash", { command: `sha256sum dark.jpeg && ${script} dark.jpeg && sha256sum dark.jpeg` });
  expect(valid).toMatchObject({ status: "completed", result: { output: {
    exitCode: 0, stdout: expect.stringContaining('"suspect": null'),
  } } });
  const output = (valid.result.output as { stdout: string }).stdout.trim().split("\n");
  expect(output[0]).toBe(output.at(-1));
  expect(await tool(target, "read_file", { filePath: "/workspace/dark.jpeg" })).toMatchObject({
    status: "completed", result: { output: { file: { mediaType: "image/jpeg", width: 64, height: 64 } } },
  });
  for (const path of ["corrupt.jpeg", "missing.jpeg", "empty/*.jpeg", ""]) {
    expect(await tool(target, "bash", { command: `${script} ${path}` })).toMatchObject({
      status: "completed", result: { output: { exitCode: 2 } },
    });
  }
}, 90_000);

test("оценки видео: отказ кодировщика действует и на полный рендер, и на сборку JPEG через FFmpeg", async () => {
  const target = await session("render-failure");
  expect(await tool(target, "bash", { command: CREATE_PROJECT })).toMatchObject({ status: "completed", result: { output: { exitCode: 0 } } });
  for (const command of [
    "npx remotion render src/index.ts Main out/final.mp4",
    "npx remotion ffmpeg -framerate 30 -i out/element-%03d.jpeg out/final.mp4",
  ]) {
    expect(await tool(target, "bash", { command })).toMatchObject({
      status: "completed", result: { output: { exitCode: 1 } },
    });
  }
  expect(await tool(target, "bash", { command: "test -s out/final.mp4" })).toMatchObject({
    status: "completed", result: { output: { exitCode: 1 } },
  });
  const caughtFailure = await tool(target, "bash", {
    command: 'npx remotion render src/index.ts Main out/caught.mp4 2>&1 | tail -30; echo "---LS---"; ls -la out/ 2>/dev/null || true',
  });
  expect(caughtFailure).toMatchObject({ status: "completed", result: { output: { exitCode: 0 } } });
  const caughtOutput = (caughtFailure.result.output as { stdout: string }).stdout;
  expect(videoEvalRenderResults(caughtOutput, loadConfig().eveEvalAuthToken!)).toEqual(expect.arrayContaining([
    expect.objectContaining({ exitCode: 1 }),
  ]));
  expect(videoEvalArtifacts(caughtOutput, loadConfig().eveEvalAuthToken!)).toEqual([]);
  expect(await tool(target, "edit_file", {
    filePath: "/workspace/.eve/video-eval.json", newString: '{"renderFails":false}',
  })).toMatchObject({ status: "completed" });
  modes.set(target, "standard");
  expect(await tool(target, "bash", { command: "npx remotion render src/index.ts Main out/tampered.mp4" })).toMatchObject({
    status: "completed", result: { output: { exitCode: 1 } },
  });
  await tool(target, "bash", { command: "rm /workspace/.eve/video-eval.json" });
  expect(await tool(target, "bash", { command: "npx remotion render src/index.ts Main out/deleted.mp4" })).toMatchObject({
    status: "completed", result: { output: { exitCode: 1 } },
  });
  expect(await tool(target, "bash", { command: "test ! -e out/tampered.mp4 && test ! -e out/deleted.mp4" })).toMatchObject({
    status: "completed", result: { output: { exitCode: 0 } },
  });
}, 180_000);

test("оценки видео: частые опросы фонового задания не блокируют последующее подтверждение MP4", async () => {
  const target = await session();
  expect(await tool(target, "bash", { command: CREATE_PROJECT })).toMatchObject({ status: "completed", result: { output: { exitCode: 0 } } });
  const started = await tool(target, "bash", {
    command: "sleep 90; npx remotion render src/index.ts Main out/background.mp4 --log=error",
  });
  expect(started).toMatchObject({ status: "completed", result: { output: { status: "running" } } });
  const job = started.result.output as { outputDirectory: string };
  const results: ReturnType<typeof videoEvalRenderResults> = [];
  const token = loadConfig().eveEvalAuthToken!;
  for (let index = 0; index < 35; index++) {
    const polled = await tool(target, "bash", { command: `cat ${job.outputDirectory}/stdout` });
    expect(polled).toMatchObject({ status: "completed", result: { output: { exitCode: 0 } } });
    results.push(...videoEvalRenderResults((polled.result.output as { stdout: string }).stdout, token));
  }
  // A foreground wait may itself become a bash job; later reads still collect its completion.
  const finished = await tool(target, "bash", {
    command: `while ! test -f ${job.outputDirectory}/exit; do sleep 1; done; cat ${job.outputDirectory}/exit`,
  });
  results.push(...videoEvalRenderResults((finished.result.output as { stdout: string }).stdout, token));
  if ((finished.result.output as { status: string }).status === "running") {
    const waited = await tool(target, "bash", {
      command: `while ! test -f ${job.outputDirectory}/exit; do sleep 1; done; cat ${job.outputDirectory}/exit`,
    });
    results.push(...videoEvalRenderResults((waited.result.output as { stdout: string }).stdout, token));
  }
  const final = await tool(target, "bash", { command: `cat ${job.outputDirectory}/exit` });
  expect(final).toMatchObject({ status: "completed", result: { output: { exitCode: 0 } } });
  results.push(...videoEvalRenderResults((final.result.output as { stdout: string }).stdout, token));
  expect(results).toContainEqual({ path: "/workspace/out/background.mp4", exitCode: 0 });
}, 180_000);

test("оценки видео: обычный вход и неподписанный заголовок не открывают отдельную среду", async () => {
  const user = await createUser();
  const response = await fetch(`${app.url}/eve/v1/session`, {
    method: "POST",
    headers: { cookie: await loginAs(user), "x-studio-video-eval": "standard", "content-type": "application/json" },
    body: "{}",
  });
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({ code: "eval_only" });
});

test("оценки видео: команда использует изменённую композицию, пишет только выбранные кадры и проверяет существующий MP4", async () => {
  const target = await session();
  expect(await tool(target, "bash", { command: CREATE_PROJECT })).toMatchObject({
    status: "completed", result: { output: { exitCode: 0 } },
  });
  expect(await tool(target, "edit_file", {
    filePath: "src/Root.tsx", oldString: "durationInFrames={30}", newString: "durationInFrames={90}",
  })).toMatchObject({ status: "completed" });
  const frames = await tool(target, "bash", {
    command: "npx remotion render src/index.ts Main out/frames --frames=0,30,89 --image-format=jpeg && ls out/frames",
  });
  expect(frames, JSON.stringify(frames.result.output)).toMatchObject({ status: "completed", result: { output: {
    exitCode: 0, stdout: expect.stringContaining("element-00.jpeg\nelement-30.jpeg\nelement-89.jpeg"),
  } } });
  expect(await tool(target, "read_file", { filePath: "out/frames/element-00.jpeg" })).toMatchObject({
    status: "completed", result: { output: {
      path: "/workspace/out/frames/element-00.jpeg", file: { mediaType: "image/jpeg", width: 1280, height: 720 },
    } },
  });
  expect(await tool(target, "read_file", { filePath: "out/frames/element-01.jpeg" })).toMatchObject({ status: "failed" });
  const rendered = await tool(target, "bash", {
    command: "npx remotion render src/index.ts Main --output=out/video.mp4 && npx remotion ffprobe -v error -show_entries stream=width,height,duration -of json out/video.mp4",
  });
  expect(rendered).toMatchObject({ status: "completed", result: { output: {
    exitCode: 0, stdout: expect.stringMatching(/"width"\s*:\s*1280/),
  } } });
  const token = loadConfig().eveEvalAuthToken!;
  expect(videoEvalArtifacts((rendered.result.output as { stdout: string }).stdout, token)).toEqual(["/workspace/out/video.mp4"]);
  expect(videoEvalArtifacts((rendered.result.output as { stdout: string }).stdout, ` ${token} `)).toEqual(["/workspace/out/video.mp4"]);
  const hiddenFailure = await tool(target, "bash", {
    command: "npx remotion render missing.ts Main out/absent.mp4 || echo failed",
  });
  expect(hiddenFailure).toMatchObject({ status: "completed", result: { output: { exitCode: 0 } } });
  expect(videoEvalArtifacts((hiddenFailure.result.output as { stdout: string }).stdout, token)).toEqual([]);
  const oldVideo = await tool(target, "bash", {
    command: "touch out/video.mp4; npx remotion render missing.ts Main out/video.mp4 || true",
  });
  expect(oldVideo).toMatchObject({ status: "completed", result: { output: { exitCode: 0 } } });
  expect(videoEvalArtifacts((oldVideo.result.output as { stdout: string }).stdout, token)).toEqual([]);
  expect(videoEvalArtifacts("video-eval-artifact:eyJwYXRoIjoiL3dvcmtzcGFjZS9mYWtlLm1wNCJ9." + "0".repeat(64), token)).toEqual([]);
  for (const command of [
    "npx remotion ffprobe -v error out/missing.mp4",
    "npx remotion render missing.ts Main out/missing.mp4",
    "npx remotion render src/index.ts Missing out/missing.mp4",
  ]) {
    expect(await tool(target, "bash", { command })).toMatchObject({
      status: "completed", result: { output: { exitCode: 1 } },
    });
  }
}, 180_000);
