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
});
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
}, 60_000);

test("оценки видео: отказ кодировщика действует и на полный рендер, и на сборку JPEG через FFmpeg", async () => {
  const target = await session("render-failure");
  await tool(target, "bash", { command: "cp -r /opt/remotion/src /workspace/src" });
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
  expect(videoEvalRenderResults(caughtOutput, loadConfig().eveEvalAuthToken!)).toEqual([
    { path: "/workspace/out/caught.mp4", exitCode: 1 },
  ]);
  expect(videoEvalArtifacts(caughtOutput, loadConfig().eveEvalAuthToken!)).toEqual([]);
  expect(await tool(target, "edit_file", {
    filePath: "/workspace/.eve/video-eval.json", oldString: '"renderFails":true', newString: '"renderFails":false',
  })).toMatchObject({ status: "completed" });
  expect(await tool(target, "bash", { command: "npx remotion render src/index.ts Main out/tampered.mp4" })).toMatchObject({
    status: "completed", result: { output: { exitCode: 1, stderr: expect.stringContaining("configuration was modified") } },
  });
  await tool(target, "bash", { command: "rm /workspace/.eve/video-eval.json" });
  expect(await tool(target, "bash", { command: "npx remotion render src/index.ts Main out/deleted.mp4" })).toMatchObject({
    status: "completed", result: { output: { exitCode: 1, stderr: expect.stringContaining("missing video eval configuration") } },
  });
  expect(await tool(target, "bash", { command: "test ! -e out/tampered.mp4 && test ! -e out/deleted.mp4" })).toMatchObject({
    status: "completed", result: { output: { exitCode: 0 } },
  });
}, 60_000);

test("оценки видео: обычный вход и неподписанный заголовок не открывают виртуальную среду", async () => {
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
  expect(await tool(target, "bash", { command: "cp -r /opt/remotion/src /workspace/src" })).toMatchObject({
    status: "completed", result: { output: { exitCode: 0 } },
  });
  expect(await tool(target, "edit_file", {
    filePath: "src/Root.tsx", oldString: "durationInFrames={30}", newString: "durationInFrames={90}",
  })).toMatchObject({ status: "completed" });
  expect(await tool(target, "bash", {
    command: "npx remotion render src/index.ts Main out/frames --frames=0,30,89 --image-format=jpeg && ls out/frames",
  })).toMatchObject({ status: "completed", result: { output: {
    exitCode: 0, stdout: expect.stringContaining("element-00.jpeg\nelement-30.jpeg\nelement-89.jpeg"),
  } } });
  expect(await tool(target, "read_file", { filePath: "out/frames/element-00.jpeg" })).toMatchObject({
    status: "completed", result: { output: { path: "/workspace/out/frames/element-00.jpeg" } },
  });
  expect(await tool(target, "read_file", { filePath: "out/frames/element-01.jpeg" })).toMatchObject({ status: "failed" });
  const rendered = await tool(target, "bash", {
    command: "npx remotion render src/index.ts Main --output=out/video.mp4 && npx remotion ffprobe -v error -show_entries stream=width,height,duration -of json out/video.mp4",
  });
  expect(rendered).toMatchObject({ status: "completed", result: { output: {
    exitCode: 0, stdout: expect.stringContaining('"width":1280,"height":720,"duration":"3.000000"'),
  } } });
  const token = loadConfig().eveEvalAuthToken!;
  expect(videoEvalArtifacts((rendered.result.output as { stdout: string }).stdout, token)).toEqual(["/workspace/out/video.mp4"]);
  expect(videoEvalArtifacts((rendered.result.output as { stdout: string }).stdout, ` ${token} `)).toEqual(["/workspace/out/video.mp4"]);
  const hiddenFailure = await tool(target, "bash", {
    command: "npx remotion render missing.ts Main out/absent.mp4 || echo failed",
  });
  expect(hiddenFailure).toMatchObject({ status: "completed", result: { output: { exitCode: 0 } } });
  expect(videoEvalArtifacts((hiddenFailure.result.output as { stdout: string }).stdout, token)).toEqual([]);
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
}, 90_000);
