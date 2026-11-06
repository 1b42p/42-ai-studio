import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { acquireCheckpointLock } from "./checkpoint-lock.mjs";

const MODULE = new URL("./checkpoint-lock.mjs", import.meta.url).href;
const OWNER = `
const { acquireCheckpointLock } = await import(process.argv[1]);
process.once('disconnect', () => process.exit(0));
if (process.argv[3] === 'bad-exec') process.execPath = '/nonexistent-checkpoint-node';
try {
  const release = await acquireCheckpointLock(process.argv[2]);
  process.on('message', async (message) => {
    if (message === 'release') {
      await Promise.all([release(), release()]);
      process.send({type:'released'}, () => process.disconnect());
    } else if (message === 'exit') process.exit(0);
  });
  process.send({type:'acquired'});
} catch (error) {
  process.send({type:'rejected', message:error.message}, () => process.disconnect());
}
`;
const WAITER = `
process.once('disconnect', () => process.exit(0));
process.once('message', () => process.disconnect());
process.send({type:'acquired'});
`;

async function fixture(t) {
  const root = await mkdtemp("/tmp/opencode/checkpoint-lock-");
  const children = [];
  t.after(async () => {
    for (const { child } of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
    await Promise.all(children.map(({ closed }) => closed));
    await rm(root, { recursive: true, force: true });
  });
  function launch(command, args) {
    const child = spawn(command, args, { env: {}, stdio: ["ignore", "ignore", "pipe", "ipc"] });
    let stderr = "", rejectMessage;
    const queue = [], waiting = [];
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("message", (message) => {
      const accept = waiting.shift();
      if (accept) accept(message); else queue.push(message);
    });
    const closed = new Promise((accept) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        rejectMessage?.(new Error(`Harness close timeout; ${stderr}`));
        accept({ code: null, signal: "timeout", stderr });
      }, 10_000);
      child.on("error", (error) => rejectMessage?.(error));
      child.once("close", (code, signal) => {
        clearTimeout(timer);
        rejectMessage?.(new Error(`Harness exited: ${code ?? signal}; ${stderr}`));
        accept({ code, signal, stderr });
      });
    });
    const handle = { child, closed, async message() {
      if (queue.length) return queue.shift();
      return new Promise((accept, reject) => {
        const timer = setTimeout(() => reject(new Error("Harness IPC timeout")), 5_000);
        rejectMessage = (error) => { clearTimeout(timer); reject(error); };
        waiting.push((message) => { clearTimeout(timer); rejectMessage = undefined; accept(message); });
      });
    } };
    children.push(handle);
    return handle;
  }
  return { root, launch, owner: (directory = root, mode = "") => launch(process.execPath,
    ["--input-type=module", "-e", OWNER, MODULE, directory, mode]) };
}

test("конкурентные процессы не захватывают checkpoint; release допускает повторный вызов", { timeout: 15_000 }, async (t) => {
  const { root, owner } = await fixture(t);
  const first = owner();
  assert.equal((await first.message()).type, "acquired");
  assert.equal((await stat(join(root, ".run.lock"))).mode & 0o777, 0o600);
  const before = await stat(join(root, ".run.lock"));
  const contenders = Array.from({ length: 4 }, () => owner());
  for (const contender of contenders) {
    assert.match((await contender.message()).message, /уже используется/u);
    assert.equal((await contender.closed).code, 0);
  }
  first.child.send("release");
  assert.equal((await first.message()).type, "released");
  assert.equal((await first.closed).code, 0);
  const next = owner();
  assert.equal((await next.message()).type, "acquired");
  assert.equal((await stat(join(root, ".run.lock"))).ino, before.ino);
  next.child.send("release");
  assert.equal((await next.message()).type, "released");
  assert.equal((await next.closed).code, 0);
});

for (const termination of ["SIGKILL", "exit"]) {
  test(`завершение владельца (${termination}) освобождает OS-lock без удаления файла`, { timeout: 15_000 }, async (t) => {
    const { root, owner, launch } = await fixture(t);
    const first = owner();
    assert.equal((await first.message()).type, "acquired");
    // Blocking kernel waiter gives an event after helper shutdown, without polling.
    const waiter = launch("/usr/bin/flock", ["--exclusive", "--no-fork", join(root, ".run.lock"),
      process.execPath, "-e", WAITER]);
    if (termination === "exit") first.child.send("exit"); else first.child.kill(termination);
    const result = await first.closed;
    assert.equal(termination === "exit" ? result.code : result.signal, termination === "exit" ? 0 : termination);
    assert.equal((await waiter.message()).type, "acquired");
    waiter.child.send("release");
    assert.equal((await waiter.closed).code, 0);
    const next = owner();
    assert.equal((await next.message()).type, "acquired");
    next.child.send("release");
    assert.equal((await next.message()).type, "released");
    assert.equal((await next.closed).code, 0);
  });
}

test("символическая ссылка и небезопасные права отклоняются без изменения чужого файла", async (t) => {
  const { root } = await fixture(t);
  const target = join(root, "untouched");
  await writeFile(target, "preserved", { mode: 0o644 });
  const lock = join(root, ".run.lock");
  await symlink(target, lock);
  await assert.rejects(acquireCheckpointLock(root), { code: "ELOOP" });
  assert.equal(await readFile(target, "utf8"), "preserved");
  assert.equal((await stat(target)).mode & 0o777, 0o644);
  await rm(lock);
  await writeFile(lock, "existing", { mode: 0o644 });
  await assert.rejects(acquireCheckpointLock(root), /Небезопасный/u);
  assert.equal(await readFile(lock, "utf8"), "existing");
  assert.equal((await stat(lock)).mode & 0o777, 0o644);
});

test("ошибка запуска Node-помощника не подтверждает захват", { timeout: 15_000 }, async (t) => {
  const { root, owner } = await fixture(t);
  const broken = owner(root, "bad-exec");
  const message = await broken.message();
  assert.equal(message.type, "rejected");
  assert.match(message.message, /завершился/u);
  assert.equal((await broken.closed).code, 0);
  const next = owner();
  assert.equal((await next.message()).type, "acquired");
  next.child.send("release");
  assert.equal((await next.message()).type, "released");
  assert.equal((await next.closed).code, 0);
});

test("потеря помощника останавливает владельца, не позволяя продолжать без lock", { timeout: 15_000 }, async (t) => {
  const { owner } = await fixture(t);
  const first = owner();
  assert.equal((await first.message()).type, "acquired");
  const pid = first.child.pid;
  const helpers = (await readFile(`/proc/${pid}/task/${pid}/children`, "utf8")).trim().split(/\s+/u);
  assert.equal(helpers.length, 1);
  process.kill(Number(helpers[0]), "SIGKILL");
  const result = await first.closed;
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Потеряна блокировка/u);
});
