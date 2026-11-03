/** Фоновые команды `bash`: маршрут задания поверх фиктивной песочницы (#11). */
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, test } from "vitest";

import { bashJobs, sandboxes, type User } from "../../lib/db/schema";
import { sleep } from "../../lib/sleep";
import { fetchApp } from "./support/app";
import { loginAs } from "./support/auth";
import { createSessionAs, eveClientAs, readStreamUntil, waitForStoredEvents } from "./support/chat";
import { createDaytonaKey, createUser, db, resetDatabase } from "./support/db";
import { fakeSandbox } from "./support/fake-sandbox";
import { fakeMachineFor } from "./support/sandbox-session";

const JOB_ID = "3f9a1c2e";
const OTHER_JOB_ID = "1a2b3c4d";

beforeEach(async () => {
  await resetDatabase();
  await fakeSandbox.reset();
});

/** Песочница, которую маршрут найдёт по строке `sandboxes`. */
async function provisionSandbox(appSessionId: string) {
  const key = await createDaytonaKey();
  const machine = await fakeMachineFor(appSessionId);
  await db().insert(sandboxes).values({
    appSessionId,
    daytonaKeyId: key.id,
    daytonaSandboxId: machine.id,
    state: "started",
    lastActiveAt: new Date(),
  });
  return { key, machine };
}

function bashRunning(jobId = JOB_ID) {
  return {
    status: "running",
    pid: 4312,
    outputDirectory: `/tmp/.eve/jobs/${jobId}`,
    stdout: "старт\n",
    stderr: "",
    truncated: false,
    message: "Команда продолжает работать",
  };
}

/** Первый ход сессии с подменённым результатом `bash`. */
async function startBashJob(user: User, appSessionId: string, jobId = JOB_ID) {
  const client = await eveClientAs(user, appSessionId);
  const created = await client.sessions.create({
    message: '/tool bash {"command":"npm run render"}',
    stubs: [{ id: "bash-running", tool: "bash", outcome: { response: bashRunning(jobId) } }],
  });
  await readStreamUntil(created.response, "session.waiting");
  const stored = await waitForStoredEvents(
    user,
    appSessionId,
    (events) => events.some((event) => event.payload.type === "session.waiting"),
  );
  expect(stored.some((event) => event.payload.type === "action.result")).toBe(true);
  return created.session;
}

async function writeJobFiles(appSessionId: string, jobId: string, files: Record<string, string>) {
  for (const [name, content] of Object.entries(files)) {
    await fakeSandbox.files.write(appSessionId, `/tmp/.eve/jobs/${jobId}/${name}`, content);
  }
}

async function job(appSessionId: string, jobId = JOB_ID) {
  const rows = await db().select().from(bashJobs).where(eq(bashJobs.jobId, jobId));
  return rows.find((row) => row.appSessionId === appSessionId) ?? null;
}

async function response(appSessionId: string, jobId: string, cookie: string) {
  return fetchApp(`/api/sessions/${appSessionId}/jobs/${jobId}`, { headers: { cookie } });
}

describe("GET /api/sessions/:id/jobs/:jobId", () => {
  test("running, completed и saved после остановки песочницы", async () => {
    const user = await createUser();
    const { id } = await createSessionAs(user);
    const { machine } = await provisionSandbox(id);
    await startBashJob(user, id);

    const row = await job(id);
    expect(row).toMatchObject({
      status: "running",
      jobId: JOB_ID,
      stdoutTail: "старт\n",
      stderrTail: "",
      stdoutBytes: Buffer.byteLength("старт\n"),
      exitCode: null,
    });

    await writeJobFiles(id, JOB_ID, {
      stdout: "кадр 1\nкадр 2\n",
      stderr: "предупреждение\n",
      pid: "4312\n",
    });

    const cookie = await loginAs(user);
    const running = await response(id, JOB_ID, cookie);
    expect(running.status).toBe(200);
    expect(await running.json()).toEqual({
      jobId: JOB_ID,
      status: "running",
      exitCode: null,
      stdout: "кадр 1\nкадр 2\n",
      stderr: "предупреждение\n",
      stdoutBytes: Buffer.byteLength("кадр 1\nкадр 2\n"),
      stderrBytes: Buffer.byteLength("предупреждение\n"),
      truncated: false,
      source: "sandbox",
      updatedAt: expect.any(String),
    });

    await writeJobFiles(id, JOB_ID, { exit: "0\n" });
    await sleep(1_100);
    const completed = await response(id, JOB_ID, cookie);
    expect(completed.status).toBe(200);
    expect(await completed.json()).toMatchObject({
      status: "completed",
      exitCode: 0,
      stdout: "кадр 1\nкадр 2\n",
      stderr: "предупреждение\n",
      source: "sandbox",
    });
    expect(await job(id)).toMatchObject({ status: "completed", exitCode: 0 });

    const before = (await fakeSandbox.counters()).started;
    await fakeSandbox.stop(id);
    await sleep(1_100);
    const saved = await response(id, JOB_ID, cookie);
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({
      status: "completed",
      exitCode: 0,
      stdout: "кадр 1\nкадр 2\n",
      stderr: "предупреждение\n",
      source: "saved",
    });
    expect((await fakeSandbox.counters()).started).toBe(before);
    expect(machine.state).toBe("stopped");
  }, 60_000);

  test("каталог без pid ещё считается идущим", async () => {
    const user = await createUser();
    const { id } = await createSessionAs(user);
    await provisionSandbox(id);
    await startBashJob(user, id);
    await writeJobFiles(id, JOB_ID, { stdout: "первый кадр\n" });

    expect(await (await response(id, JOB_ID, await loginAs(user))).json()).toMatchObject({
      status: "running",
      exitCode: null,
      stdout: "первый кадр\n",
    });
  }, 60_000);

  test("убитый процесс без exit — interrupted при запущенной песочнице", async () => {
    const user = await createUser();
    const { id } = await createSessionAs(user);
    await provisionSandbox(id);
    await startBashJob(user, id);
    await writeJobFiles(id, JOB_ID, { stdout: "до остановки\n", pid: "4312\n" });
    await fakeSandbox.killProcess(id, JOB_ID);

    const body = await (await response(id, JOB_ID, await loginAs(user))).json();
    expect(body).toMatchObject({
      status: "interrupted",
      exitCode: null,
      stdout: "до остановки\n",
      source: "sandbox",
    });
    expect(await job(id)).toMatchObject({ status: "interrupted", exitCode: null });
  }, 60_000);

  test("незавершённое задание при остановленной песочнице — interrupted без запуска", async () => {
    const user = await createUser();
    const { id } = await createSessionAs(user);
    await provisionSandbox(id);
    await startBashJob(user, id);
    await writeJobFiles(id, JOB_ID, { stdout: "последний кадр\n", pid: "4312\n" });
    const cookie = await loginAs(user);
    expect(await (await response(id, JOB_ID, cookie)).json()).toMatchObject({ status: "running" });
    await fakeSandbox.stop(id);
    await sleep(1_100);
    const started = (await fakeSandbox.counters()).started;

    const body = await (await response(id, JOB_ID, cookie)).json();
    expect(body).toMatchObject({
      status: "interrupted",
      stdout: "последний кадр\n",
      source: "saved",
    });
    expect((await fakeSandbox.counters()).started).toBe(started);
    expect(await job(id)).toMatchObject({ status: "interrupted" });
  }, 60_000);

  test("хвост больше 64 КиБ: truncated и ровно последние 64 КиБ", async () => {
    const user = await createUser();
    const { id } = await createSessionAs(user);
    await provisionSandbox(id);
    await startBashJob(user, id);

    const lines = "строка вывода\n".repeat(9000);
    await writeJobFiles(id, JOB_ID, { stdout: lines, pid: "4312\n" });

    const body = await (await response(id, JOB_ID, await loginAs(user))).json() as {
      stdout: string;
      stdoutBytes: number;
      truncated: boolean;
    };
    expect(body.truncated).toBe(true);
    expect(body.stdoutBytes).toBe(Buffer.byteLength(lines));
    // Первая неполная строка отброшена, остальные строки целые.
    expect(body.stdout.endsWith("строка вывода\n")).toBe(true);
    expect(body.stdout.includes("\ufffd")).toBe(false);
    expect(Buffer.byteLength(body.stdout)).toBeLessThanOrEqual(64 * 1024);
    for (const line of body.stdout.split("\n").slice(0, -1)) {
      expect(line).toBe("строка вывода");
    }
  }, 60_000);

  test("длинный JSON без перевода строки остаётся хвостом целиком", async () => {
    const user = await createUser();
    const { id } = await createSessionAs(user);
    await provisionSandbox(id);
    await startBashJob(user, id);
    const json = `{"progress":${"1".repeat(70_000)}}`;
    await writeJobFiles(id, JOB_ID, { stdout: json, pid: "4312\n" });

    const body = await (await response(id, JOB_ID, await loginAs(user))).json() as {
      stdout: string;
      truncated: boolean;
    };
    expect(body.truncated).toBe(true);
    expect(body.stdout.length).toBe(64 * 1024);
    expect(body.stdout).toBe(json.slice(-64 * 1024));
  }, 60_000);

  test("последний опрос обновляет last_active_at, но не будит песочницу", async () => {
    const user = await createUser();
    const { id } = await createSessionAs(user);
    await provisionSandbox(id);
    await startBashJob(user, id);
    const old = new Date(Date.now() - 2 * 60_000);
    await db().update(sandboxes).set({ lastActiveAt: old }).where(eq(sandboxes.appSessionId, id));
    await writeJobFiles(id, JOB_ID, { stdout: "работаю\n", pid: "4312\n" });

    const started = (await fakeSandbox.counters()).started;
    await response(id, JOB_ID, await loginAs(user));
    const [row] = await db().select().from(sandboxes).where(eq(sandboxes.appSessionId, id));
    expect(row.lastActiveAt.getTime()).toBeGreaterThan(old.getTime());
    expect((await fakeSandbox.counters()).started).toBe(started);
  }, 60_000);

  test("два запроса в пределах секунды читают песочницу один раз", async () => {
    const user = await createUser();
    const { id } = await createSessionAs(user);
    await provisionSandbox(id);
    await startBashJob(user, id);
    await writeJobFiles(id, JOB_ID, { stdout: "работаю\n", pid: "4312\n" });
    const cookie = await loginAs(user);
    await response(id, JOB_ID, cookie); // прогреваем кэш
    await sleep(1_100);

    const before = (await fakeSandbox.calls(id)).filter(
      (call) => call.op === "readJobDirectory",
    ).length;
    const [first, second] = await Promise.all([
      response(id, JOB_ID, cookie),
      response(id, JOB_ID, cookie),
    ]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const after = (await fakeSandbox.calls(id)).filter(
      (call) => call.op === "readJobDirectory",
    ).length;
    expect(after).toBe(before + 1);
  }, 60_000);

  test("чужая сессия, неизвестное задание, сессия без песочницы — 404", async () => {
    const owner = await createUser();
    const stranger = await createUser();
    const owned = await createSessionAs(owner);
    await provisionSandbox(owned.id);
    await startBashJob(owner, owned.id);

    const ownerCookie = await loginAs(owner);
    const strangerCookie = await loginAs(stranger);
    expect((await response(owned.id, JOB_ID, strangerCookie)).status).toBe(404);

    const unknown = await response(owned.id, OTHER_JOB_ID, ownerCookie);
    expect(unknown.status).toBe(404);

    const bare = await createSessionAs(owner);
    const bareCookie = await loginAs(owner);
    expect((await response(bare.id, JOB_ID, bareCookie)).status).toBe(404);
  }, 60_000);

  test("без входа — 401, некорректный jobId — 400", async () => {
    const user = await createUser();
    const { id } = await createSessionAs(user);
    const anonymous = await fetchApp(`/api/sessions/${id}/jobs/${JOB_ID}`);
    expect(anonymous.status).toBe(401);

    const cookie = await loginAs(user);
    // `..` и `%2e%2e` нормализуются URL до запроса и до маршрута не доходят —
    // это правило роутера Next.js, как и для пустого сегмента и `a/b`.
    for (const jobId of ["a%2Fb", "ZZZZZZZZ", "3f9a1c2e0"]) {
      const result = await fetchApp(`/api/sessions/${id}/jobs/${jobId}`, { headers: { cookie } });
      expect(result.status, jobId).toBe(400);
    }
  });

  test("«Стоп» не останавливает фоновую команду и не мешает опросу", async () => {
    const user = await createUser();
    const { id } = await createSessionAs(user);
    await provisionSandbox(id);
    const session = await startBashJob(user, id);
    await writeJobFiles(id, JOB_ID, { stdout: "первый кадр\n", pid: "4312\n" });
    const cookie = await loginAs(user);

    expect(await (await response(id, JOB_ID, cookie)).json()).toMatchObject({ status: "running" });

    const stopped = (await fakeSandbox.counters()).stopped;
    const client = await eveClientAs(user, id);
    const slow = client.sessions.attach(session.state.sessionId);
    const stream = readStreamUntil(await slow.send("/slow 20 отмена"), "turn.cancelled");
    await waitForStoredEvents(
      user,
      id,
      (events) => events.filter((event) => event.payload.type === "message.received").length >= 2,
    );
    const cancelled = await slow.cancel();
    expect(cancelled.status).toBe("accepted");
    await stream;

    await sleep(1_100);
    expect(await (await response(id, JOB_ID, cookie)).json()).toMatchObject({ status: "running" });
    await writeJobFiles(id, JOB_ID, { exit: "0\n" });
    await sleep(1_100);
    expect(await (await response(id, JOB_ID, cookie)).json()).toMatchObject({
      status: "completed",
      exitCode: 0,
    });
    expect((await fakeSandbox.counters()).stopped).toBe(stopped);
  }, 60_000);
});
