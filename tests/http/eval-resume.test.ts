import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { watch } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Client } from "eve/client";
import { expect, inject, test } from "vitest";

import { loadConfig } from "../../lib/config";
import { CheckpointStore } from "../../evals/support/checkpoint-store.mjs";
import { testEnvValues } from "./support/app";

function runEval(id: string, directory: string) {
  const child = spawn(process.execPath, ["node_modules/eve/bin/eve.js", "eval", id,
    "--url", inject("appUrl"), "--json", "--strict"], {
    cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...testEnvValues(), EVAL_CHECKPOINT_DIR: directory },
  });
  let stdout = "", stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exited = new Promise<number | null>((accept, reject) => {
    child.once("error", reject);
    child.once("close", accept);
  });
  return { child, exited, output: () => ({ stdout, stderr }) };
}

test("оценки: после остановки сборщика продолжается прежний ход без повторных сообщений", async () => {
  const id = `resume-${randomUUID()}`;
  const directory = resolve(".tmp", id);
  const source = resolve("evals", `${id}.eval.ts`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(source, `
import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";
import { resumableSession } from "./support/resumable-session";
export default defineEval({
  async test(t) {
    const session = await resumableSession(t, ${JSON.stringify(id)}, { stubs: [] });
    const first = await session.send("Первый ход");
    const second = await session.send("/slow 5 Второй ход");
    t.check(first.message, equals("Эхо: Первый ход"));
    t.check(second.message, equals("Эхо: Второй ход"));
    t.check(second.sessionId, equals(first.sessionId));
    t.succeeded();
  },
});
`, { flag: "wx" });
  const store = new CheckpointStore(directory);
  await store.initialize({ target: inject("appUrl"), caseIds: [id] });
  let first: ReturnType<typeof runEval> | undefined;
  let resumed: ReturnType<typeof runEval> | undefined;
  let uncertain: ReturnType<typeof runEval> | undefined;
  let sessionId: string | undefined;
  let watcher: ReturnType<typeof watch> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const client = new Client({ host: inject("appUrl"), auth: { bearer: loadConfig().eveEvalAuthToken! }, redirect: "manual" });
  try {
    const accepted = new Promise<string>((accept, reject) => {
      timer = setTimeout(() => reject(new Error("Второй ход не был принят")), 60_000);
      const inspect = async () => {
        try {
          const progress = await store.readProgress(id);
          if (progress?.turns[1]?.phase === "accepted") {
            clearTimeout(timer);
            watcher?.close();
            accept(progress.sessionId);
          }
        } catch (error) { clearTimeout(timer); reject(error); }
      };
      watcher = watch(directory, () => { void inspect(); });
    });
    first = runEval(id, directory);
    sessionId = await Promise.race([accepted, first.exited.then((code) => {
      throw new Error(`Сборщик завершился до второго хода (код ${code}): ${JSON.stringify(first?.output())}`);
    })]);
    first.child.kill("SIGTERM");
    await first.exited;
    expect(await store.readResult(id)).toBeUndefined();
    const confirmed = await store.readProgress(id);
    if (!confirmed) throw new Error("Не сохранилась сессия оценки");
    await store.writeProgress(id, { ...confirmed, turns: confirmed.turns.map((turn, index) =>
      index === 1 ? { message: turn.message, startIndex: turn.startIndex, phase: "sending" } : turn) });
    uncertain = runEval(id, directory);
    expect(await uncertain.exited, uncertain.output().stderr).toBe(1);
    expect(await store.readResult(id)).toBeUndefined();
    await store.writeProgress(id, confirmed);
    resumed = runEval(id, directory);
    expect(await resumed.exited, resumed.output().stderr).toBe(0);
    const result = await store.readResult(id);
    expect(result).toMatchObject({ verdict: "passed", result: { sessionId } });
    const snapshot = await client.sessions.attach(sessionId).snapshot();
    const messages = snapshot.events.filter((event) => event.type === "message.received");
    expect(messages.map((event) => event.data.message)).toEqual(["Первый ход", "/slow 5 Второй ход"]);
    expect((await store.readProgress(id))?.turns.map(({ receivedEventId }) => receivedEventId))
      .toEqual(messages.map((event) => event.meta.id));
    expect((await store.readProgress(id))?.turns.map(({ phase }) => phase)).toEqual(["settled", "settled"]);
  } finally {
    clearTimeout(timer);
    watcher?.close();
    for (const run of [first, uncertain, resumed]) {
      if (run && run.child.exitCode === null && run.child.signalCode === null) run.child.kill("SIGTERM");
    }
    await Promise.allSettled([first?.exited, uncertain?.exited, resumed?.exited]);
    if (sessionId) await client.sessions.attach(sessionId).reset();
    await rm(source, { force: true });
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);
