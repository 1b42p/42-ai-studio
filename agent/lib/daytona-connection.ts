import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import {
  DaytonaNotFoundError,
  SandboxState,
  type Sandbox,
} from "@daytona/sdk";
import type { SandboxConnection } from "eve/sandbox/provider";
import { StudioSandboxError } from "@/lib/sandbox/errors";
import { abortable } from "@/lib/sandbox/abort";

type Callbacks = {
  onStop(): Promise<void>;
  onActivity(): Promise<void>;
};

// Never propagate an SDK exception: it may contain authorization headers.
function failure() {
  return new StudioSandboxError("daytona_unavailable");
}

function cancelled() {
  return new DOMException("Операция отменена", "AbortError");
}

function checkAbort(signal?: AbortSignal) {
  if (signal?.aborted) throw cancelled();
}

function quote(value: string) {
  if (value.includes("\0")) throw new Error("Недопустимый нулевой байт в команде.");
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function outputStream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let ended = false;
  let length = 0;
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(value) { controller = value; },
    cancel() { ended = true; },
  });
  const append = (text: string) => {
    length += text.length;
    if (!ended && text) controller.enqueue(encoder.encode(text));
  };
  return {
    stream,
    append,
    reconcile(snapshot: string) {
      if (snapshot.length < length) throw failure();
      append(snapshot.slice(length));
    },
    close() {
      if (!ended) { ended = true; controller.close(); }
    },
    error(error: Error) {
      if (!ended) { ended = true; controller.error(error); }
    },
  };
}

export function connectDaytona(sandbox: Sandbox, callbacks: Callbacks): SandboxConnection {
  let stopping: Promise<void> | undefined;
  let stopped = false;

  async function activity(signal?: AbortSignal) {
    // eve may use a stopped connection again after the machine was resumed.
    // Keep concurrent stop calls shared, but allow another stop after reuse.
    if (stopped) { stopping = undefined; stopped = false; }
    await abortable(() => callbacks.onActivity(), signal);
    checkAbort(signal);
  }

  async function refreshState() {
    await sandbox.refreshData();
    return sandbox.state;
  }

  return {
    workspaceRoot: "/workspace",
    async spawn({ command, env, workingDirectory, abortSignal }) {
      checkAbort(abortSignal);
      const assignments = Object.entries(env).map(([key, value]) => {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
          throw new Error("Недопустимое имя переменной окружения.");
        }
        return quote(`${key}=${value}`);
      });
      const sessionId = `eve-${randomUUID()}`;
      const directory = `/tmp/.studio-exec-${randomUUID()}`;
      const pgidFile = quote(`${directory}/pgid`);
      const cancelFile = quote(`${directory}/cancel`);
      const script = `cd -- ${quote(workingDirectory)} || exit\n${command}`;
      // setsid may fork if its caller is already a group leader; --wait preserves
      // the child's exit status. Record $$ INSIDE the new session, not $! outside.
      const child = `printf '%s\\n' "$$" > ${pgidFile}\n` +
        `[ ! -e ${cancelFile} ] || exit 137\n` +
        `exec env -- ${assignments.join(" ")} bash -lc ${quote(script)}`;
      const launch = `umask 077\nmkdir -p -- ${quote(directory)} || exit\n` +
        `[ ! -e ${cancelFile} ] || exit 137\n` +
        `setsid --wait bash -c ${quote(child)}\n` +
        `status=$?\nrm -f -- ${pgidFile}\nexit "$status"`;
      const stdout = outputStream();
      const stderr = outputStream();
      let dispatched = false;
      let finished = false;
      let killing: Promise<void> | undefined;
      const kill = (): Promise<void> => {
        if (finished || !dispatched) return Promise.resolve();
        if (killing) return killing;
        killing = (async () => {
          // Tombstone closes the abort-before-pgid race. It is checked both before
          // setsid and after the pgid is published, so no late launch can escape.
          const script = `umask 077\nmkdir -p -- ${quote(directory)} || exit\n` +
            `: > ${cancelFile}\n` +
            `if [ -f ${pgidFile} ]; then\n` +
            `  IFS= read -r pgid < ${pgidFile}\n` +
            `  case "$pgid" in ''|*[!0-9]*|0|1) exit 1;; esac\n` +
            `  kill -KILL -- "-$pgid" 2>/dev/null || {\n` +
            `    if kill -0 -- "-$pgid" 2>/dev/null; then exit 1; fi\n` +
            `  }\nfi`;
          try {
            const result = await sandbox.process.executeCommand(`bash -c ${quote(script)}`, undefined, undefined, 10);
            if (result.exitCode !== 0) throw failure();
          } catch { throw failure(); }
        })();
        // A failed kill must be retryable, but simultaneous callers share it.
        void killing.catch(() => { killing = undefined; });
        return killing;
      };
      const onAbort = () => { void kill().catch(() => {}); };
      abortSignal?.addEventListener("abort", onAbort, { once: true });
      try {
        await activity(abortSignal);
        await abortable(() => sandbox.process.createSession(sessionId), abortSignal);
        checkAbort(abortSignal);
        dispatched = true;
        const response = await abortable(() => sandbox.process.executeSessionCommand(sessionId, {
          command: `bash -c ${quote(launch)}`,
          runAsync: true,
          suppressInputEcho: true,
        }), abortSignal);
        if (!response.cmdId) throw failure();
        const commandId = response.cmdId;
        let acceptLogs = true;
        let logsFinished = false;
        // SDK has no WebSocket abort handle. Killing this command closes its log
        // producer; close() must NOT delete the session (eve jobs live there).
        const logs = sandbox.process.getSessionCommandLogs(sessionId, commandId,
          (chunk) => { if (acceptLogs) stdout.append(chunk); },
          (chunk) => { if (acceptLogs) stderr.append(chunk); },
        ).catch(() => {
          // A failed follow connection is recoverable from persisted snapshots.
        }).finally(() => { logsFinished = true; });
        const completion = (async () => {
          try {
            let exitCode: number;
            for (;;) {
              await activity(abortSignal);
              const state = await abortable(() => sandbox.process.getSessionCommand(sessionId, commandId), abortSignal);
              if (typeof state.exitCode === "number") { exitCode = state.exitCode; break; }
              // The follow socket can close before the command exits. Continue
              // delivering logs from persisted snapshots in that case.
              if (logsFinished) {
                const snapshot = await abortable(() => sandbox.process.getSessionCommandLogs(sessionId, commandId), abortSignal);
                stdout.reconcile(snapshot.stdout ?? "");
                stderr.reconcile(snapshot.stderr ?? "");
              }
              await delay(1000, undefined, { signal: abortSignal });
            }
            await abortable(() => logs, abortSignal);
            const snapshot = await abortable(() => sandbox.process.getSessionCommandLogs(sessionId, commandId), abortSignal);
            stdout.reconcile(snapshot.stdout ?? "");
            stderr.reconcile(snapshot.stderr ?? "");
            finished = true;
            stdout.close();
            stderr.close();
            return { exitCode };
          } catch {
            const error = abortSignal?.aborted ? cancelled() : failure();
            try {
              if (abortSignal?.aborted) await kill();
            } finally {
              stdout.error(error);
              stderr.error(error);
            }
            throw error;
          } finally {
            acceptLogs = false;
            abortSignal?.removeEventListener("abort", onAbort);
          }
        })();
        // wait() may be called later, or not at all by the caller.
        void completion.catch(() => {});
        return { stdout: stdout.stream, stderr: stderr.stream, kill, wait: () => completion };
      } catch {
        abortSignal?.removeEventListener("abort", onAbort);
        if (dispatched) await kill();
        throw abortSignal?.aborted ? cancelled() : failure();
      }
    },
    async readFile({ path, abortSignal }) {
      try {
        await activity(abortSignal);
        const info = await abortable(() => sandbox.fs.getFileDetails(path), abortSignal);
        if (info.isDir) {
          throw Object.assign(new Error("EISDIR: path is a directory"), { code: "EISDIR" });
        }
        const source = await sandbox.fs.downloadFileStream(path, { signal: abortSignal });
        // The consumer may not request its first chunk immediately.
        source.on("error", () => {});
        // Sanitize errors raised AFTER the download promise resolves as well.
        const safe = Readable.from((async function* () {
          try {
            for await (const chunk of source) {
              checkAbort(abortSignal);
              yield chunk;
            }
            checkAbort(abortSignal);
          } catch { throw abortSignal?.aborted ? cancelled() : failure(); }
        })(), { objectMode: false });
        return Readable.toWeb(safe) as ReadableStream<Uint8Array>;
      } catch (error) {
        checkAbort(abortSignal);
        if (error instanceof DaytonaNotFoundError) return null;
        if (error instanceof Error && "code" in error && error.code === "EISDIR") throw error;
        throw failure();
      }
    },
    async writeFiles({ files, abortSignal }) {
      try {
        await activity(abortSignal);
        if (!files.length) return;
        const directories = new Set(files.map(({ path }) => posix.dirname(path)));
        for (const directory of directories) {
          await abortable(() => sandbox.fs.createFolder(directory, "755"), abortSignal);
        }
        await abortable(() => sandbox.fs.uploadFiles(files.map(({ content, path }) => ({
          // Share the existing bytes rather than copying a potentially 2 GiB file.
          source: Buffer.from(content.buffer, content.byteOffset, content.byteLength),
          destination: path,
        }))), abortSignal);
        checkAbort(abortSignal);
      } catch { checkAbort(abortSignal); throw failure(); }
    },
    async removePath({ path, force, recursive, abortSignal }) {
      try {
        await activity(abortSignal);
        await abortable(() => sandbox.fs.deleteFile(path, recursive ?? false), abortSignal);
        checkAbort(abortSignal);
      } catch (error) {
        checkAbort(abortSignal);
        if (force && error instanceof DaytonaNotFoundError) return;
        throw failure();
      }
    },
    stop() {
      if (stopping) return stopping;
      stopping = (async () => {
        try {
          let state = await refreshState();
          if (state === SandboxState.STOPPING) await sandbox.waitUntilStopped(300);
          else if (state !== SandboxState.STOPPED && state !== SandboxState.ARCHIVED) {
            try { await sandbox.stop(300); }
            catch {
              // Another connection or Daytona auto-stop may have won the race.
              state = await refreshState();
              if (state === SandboxState.STOPPING) await sandbox.waitUntilStopped(300);
              else if (state !== SandboxState.STOPPED && state !== SandboxState.ARCHIVED) throw failure();
            }
          }
          await callbacks.onStop();
          stopped = true;
        } catch { throw failure(); }
      })();
      void stopping.catch(() => { stopping = undefined; });
      return stopping;
    },
    async close() {
      // A connection lasts one eve step. Remote sessions and jobs outlive it.
    },
  };
}
