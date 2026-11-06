import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import { resolve } from "node:path";

const HELPER = `
process.once('disconnect', () => process.exit(0));
process.on('message', (message) => { if (message === 'release') process.disconnect(); });
process.send('ready', (error) => { if (error) process.exit(1); });
`;

/** Linux-only, nonblocking exclusive lock; keep it for the entire checkpoint run.
 * @param {string} directory @returns {Promise<() => Promise<void>>}
 */
export async function acquireCheckpointLock(directory) {
  if (typeof directory !== "string" || !directory.trim()) {
    throw new Error("Укажите каталог checkpoint.");
  }
  directory = resolve(directory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const dir = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  let file;
  try {
    file = await open(`/proc/self/fd/${dir.fd}/.run.lock`,
      constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o077) || info.uid !== process.getuid()) {
      throw new Error("Небезопасный файл блокировки checkpoint.");
    }
    // Reopen the verified inode, not its replaceable pathname; fd 3 is Node IPC.
    const child = spawn("/usr/bin/flock", ["--exclusive", "--nonblock", "--no-fork",
      "--conflict-exit-code", "73", "/proc/self/fd/4", process.execPath, "-e", HELPER], {
      env: {}, stdio: ["ignore", "ignore", "ignore", "ipc", file.fd],
    });
    return await holdLock(child);
  } finally {
    await file?.close();
    await dir.close();
  }
}

/** @param {import('node:child_process').ChildProcess} child */
async function holdLock(child) {
  let ready = false, releasing = false, failure;
  let acceptReady, rejectReady;
  const acquired = new Promise((accept, reject) => { acceptReady = accept; rejectReady = reject; });
  const closed = new Promise((accept) => {
    child.on("error", (error) => { failure = error; rejectReady(error); });
    child.once("close", (code, signal) => {
      if (!releasing || code !== 0) {
        failure ??= new Error(code === 73 ? "Checkpoint уже используется другим процессом."
          : `Процесс блокировки checkpoint завершился: ${signal ?? code}.`);
      }
      if (!ready) rejectReady(failure ?? new Error("Блокировка checkpoint не подтверждена."));
      else if (!releasing) {
        // Continuing paid cases after losing exclusivity is unsafe.
        process.stderr.write("Потеряна блокировка checkpoint; выполнение остановлено.\n");
        process.exit(1);
      }
      accept();
    });
  });
  child.once("message", (message) => {
    if (message === "ready") { ready = true; acceptReady(); }
    else rejectReady(new Error("Некорректное подтверждение блокировки checkpoint."));
  });
  const timeout = setTimeout(() => rejectReady(new Error("Истекло ожидание блокировки checkpoint.")), 10_000);
  try {
    await acquired;
  } catch (error) {
    releasing = true;
    child.kill("SIGKILL");
    await closed;
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  let releasePromise;
  return async function release() {
    releasePromise ??= (async () => {
      releasing = true;
      // Let the helper disconnect: Node 24 loses 'close' on parent-side disconnect.
      if (child.connected) child.send("release", (error) => {
        if (error) { failure = error; child.kill("SIGKILL"); }
      });
      await closed;
      if (failure) throw failure;
    })();
    await releasePromise;
  };
}
