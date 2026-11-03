import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import type { SandboxConnection } from "eve/sandbox/provider";

import { FakeStore, hasCode, type FakeRecord, type StoredRule } from "./fake-store";
import type { JobDirectoryReading } from "./job-directory";

interface ConnectionCallbacks {
  onStop(): Promise<void>;
  onActivity(): Promise<void>;
}

export interface FakeMachine {
  readonly id: string;
  readonly state: string;
  readonly recoverable?: boolean;
  ready(): Promise<void>;
  start(): Promise<void>;
  recover(): Promise<void>;
  delete(): Promise<void>;
  connect(callbacks: ConnectionCallbacks): SandboxConnection;
  readJobDirectory(jobId: string): Promise<JobDirectoryReading>;
}

/** A process-local handle; state getters read an atomically published snapshot. */
class FakeMachineHandle implements FakeMachine {
  readonly id: string;

  constructor(private readonly store: FakeStore, record: FakeRecord) {
    this.id = record.id;
  }

  get state(): string {
    return this.store.snapshot(this.id).state;
  }

  get recoverable(): boolean | undefined {
    return this.store.snapshot(this.id).recoverable;
  }

  async ready(): Promise<void> {
    // Fake lifecycle transitions are synchronous under the shared store lock.
  }

  async start(): Promise<void> {
    await this.store.setState(this.id, "started");
  }

  async recover(): Promise<void> {
    await this.start();
  }

  async delete(): Promise<void> {
    try {
      if (this.state === "destroyed") return;
      await this.store.setState(this.id, "destroyed");
    } catch (error) {
      if (!(error instanceof Error && "status" in error && error.status === 404)) throw error;
    }
  }

  async readJobDirectory(jobId: string): Promise<JobDirectoryReading> {
    return this.store.readJobDirectory(this.id, jobId);
  }

  connect(callbacks: ConnectionCallbacks): SandboxConnection {
    const root = this.store.machineRoot(this.id);
    const activity = async (signal?: AbortSignal) => {
      signal?.throwIfAborted();
      await callbacks.onActivity();
      signal?.throwIfAborted();
    };
    return {
      workspaceRoot: "/workspace",
      spawn: async ({ command, abortSignal }) => {
        await activity(abortSignal);
        const rule = await this.store.transaction(async (data) => {
          const machine = this.store.find(data, this.id);
          if (machine.state !== "started") throw new Error("Fake sandbox is not started");
          machine.calls.push({ op: "spawn", command, at: Date.now() });
          if (/^\s*(?:echo\s+["']?\$HOME["']?|printf\s+'%s\\n'\s+"\$HOME")\s*;?\s*$/.test(command)) {
            return { stdout: "/root\n", exitCode: 0 };
          }
          const rule = data.rules.find((candidate) =>
            new RegExp(candidate.match, candidate.flags).test(command),
          );
          if (rule !== undefined) return rule;
          const builtin = await this.store.shellBuiltin(root, command);
          return builtin ?? { stderr: `command not found: ${command}`, exitCode: 127 };
        }, abortSignal);
        return fakeProcess(rule, abortSignal);
      },
      readFile: async ({ path, abortSignal }) => {
        await activity(abortSignal);
        return this.store.transaction(async (data) => {
          this.store.find(data, this.id).calls.push({ op: "readFile", path, at: Date.now() });
          const filename = await this.store.filePath(root, path);
          let handle;
          try {
            handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
          } catch (error) {
            if (hasCode(error, "ENOENT")) return null;
            throw error;
          }
          try {
            if (!(await handle.stat()).isFile()) throw new Error("Sandbox path is not a regular file");
            abortSignal?.throwIfAborted();
            const stream = handle.createReadStream({ highWaterMark: 64 * 1024, signal: abortSignal });
            return Readable.toWeb(stream, {
              strategy: { highWaterMark: 64 * 1024, size: (chunk: Uint8Array) => chunk.byteLength },
            }) as ReadableStream<Uint8Array>;
          } catch (error) {
            await handle.close();
            throw error;
          }
        }, abortSignal);
      },
      writeFiles: async ({ files, abortSignal }) => {
        await activity(abortSignal);
        await this.store.transaction(async (data) => {
          const machine = this.store.find(data, this.id);
          for (const file of files) {
            abortSignal?.throwIfAborted();
            machine.calls.push({ op: "writeFiles", path: file.path, at: Date.now() });
            await this.store.atomicWrite(await this.store.filePath(root, file.path), file.content, abortSignal);
          }
        }, abortSignal);
      },
      removePath: async ({ path, force, recursive, abortSignal }) => {
        await activity(abortSignal);
        await this.store.transaction(async (data) => {
          this.store.find(data, this.id).calls.push({ op: "removePath", path, at: Date.now() });
          const filename = await this.store.filePath(root, path);
          abortSignal?.throwIfAborted();
          // rm without recursive rejects directories, including empty ones.
          // The connection contract allows removing an empty directory.
          try {
            const stat = await fs.lstat(filename);
            if (stat.isDirectory() && !recursive) await fs.rmdir(filename);
            else await fs.rm(filename, { force, recursive });
          } catch (error) {
            if (!(force && hasCode(error, "ENOENT"))) throw error;
          }
          abortSignal?.throwIfAborted();
        }, abortSignal);
      },
      stop: async () => {
        await this.store.transaction((data) => {
          const machine = this.store.find(data, this.id);
          machine.calls.push({ op: "stop", at: Date.now() });
          if (machine.state !== "stopped") {
            data.counters.stopped++;
            machine.state = "stopped";
          }
        });
        await callbacks.onStop();
      },
      close: async () => {},
    };
  }
}

/** Never executes shell commands on the host, including env or workingDirectory. */
function fakeProcess(rule: Pick<StoredRule, "stdout" | "stderr" | "exitCode" | "delayMs">, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", abort, { once: true });
  let stdout!: ReadableStreamDefaultController<Uint8Array>;
  let stderr!: ReadableStreamDefaultController<Uint8Array>;
  let stdoutCancelled = false;
  let stderrCancelled = false;
  const stdoutStream = new ReadableStream<Uint8Array>({
    start: (value) => { stdout = value; },
    cancel: () => { stdoutCancelled = true; },
  });
  const stderrStream = new ReadableStream<Uint8Array>({
    start: (value) => { stderr = value; },
    cancel: () => { stderrCancelled = true; },
  });
  let finished = false;
  const completion = (async () => {
    try {
      await delay(rule.delayMs ?? 0, undefined, { signal: controller.signal });
      if (!stdoutCancelled) {
        if (rule.stdout) stdout.enqueue(new TextEncoder().encode(rule.stdout));
        stdout.close();
      }
      if (!stderrCancelled) {
        if (rule.stderr) stderr.enqueue(new TextEncoder().encode(rule.stderr));
        stderr.close();
      }
      return { exitCode: rule.exitCode ?? 0 };
    } catch (error) {
      if (controller.signal.aborted && !signal?.aborted) {
        if (!stdoutCancelled) stdout.close();
        if (!stderrCancelled) stderr.close();
        return { exitCode: 137 };
      }
      if (!stdoutCancelled) stdout.error(error);
      if (!stderrCancelled) stderr.error(error);
      if (signal?.aborted) throw signal.reason;
      throw error;
    } finally {
      finished = true;
      signal?.removeEventListener("abort", abort);
    }
  })();
  // Consumers can read the streams before calling wait().
  void completion.catch(() => {});
  return {
    stdout: stdoutStream,
    stderr: stderrStream,
    wait: () => completion,
    kill: async () => {
      if (!finished) controller.abort();
      await completion.catch(() => {});
    },
  };
}

export function getFakeBackend(directory: string) {
  const store = new FakeStore(directory);
  return {
    get: async (idOrName: string): Promise<FakeMachine> => {
      const record = await store.transaction((data) => store.find(data, idOrName));
      return new FakeMachineHandle(store, record);
    },
    create: async ({ name, appSessionId }: { name: string; appSessionId: string }): Promise<FakeMachine> => {
      const { machine, failure } = await store.create(name, appSessionId);
      if (failure) {
        throw Object.assign(new Error(`Fake Daytona ${failure}: dtn_test_secret_value`), {
          status: failure === "unavailable" ? 503 : 400,
          ...(machine ? { sandboxId: machine.id } : {}),
        });
      }
      if (!machine) throw new Error("Fake Daytona did not create a machine");
      return new FakeMachineHandle(store, machine);
    },
  };
}
