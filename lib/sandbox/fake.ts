import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import type { SandboxConnection } from "eve/sandbox/provider";
import { loadConfig } from "@/lib/config";

import {
  FakeStore,
  hasCode,
  type FakeRecord,
  type FakeResources,
  type StoredRule,
} from "./fake-store";
import type { JobDirectoryReading } from "./job-directory";

interface ConnectionCallbacks {
  onStop(): Promise<void>;
  onActivity(): Promise<void>;
}

export interface FakeMachine {
  readonly id: string;
  readonly state: string;
  readonly recoverable?: boolean;
  readonly labels: Readonly<Record<string, string>>;
  readonly lastActivityAt: Date | undefined;
  readonly stoppedAt: Date | undefined;
  ready(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  archive(): Promise<void>;
  refreshActivity(): Promise<void>;
  configureLifecycle(): Promise<void>;
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

  get labels(): Readonly<Record<string, string>> {
    return { ...this.store.snapshot(this.id).labels };
  }

  get lastActivityAt(): Date | undefined {
    const value = this.store.snapshot(this.id).lastActivityAt;
    return value === undefined ? undefined : new Date(value);
  }

  get stoppedAt(): Date | undefined {
    const machine = this.store.snapshot(this.id);
    return machine.state !== "stopped" || machine.stoppedAt === undefined
      ? undefined : new Date(machine.stoppedAt);
  }

  async ready(): Promise<void> {
    // Fake lifecycle transitions are synchronous under the shared store lock.
  }

  async start(): Promise<void> {
    await this.store.setState(this.id, "started");
    await this.configureLifecycle();
  }

  async stop(): Promise<void> {
    await this.store.setState(this.id, "stopped");
  }

  async archive(): Promise<void> {
    await this.store.setState(this.id, "archived");
  }

  async refreshActivity(): Promise<void> {
    await this.store.refreshActivity(this.id);
  }

  async configureLifecycle(): Promise<void> {
    await this.store.configureLifecycle(this.id, lifecycleIntervals());
  }

  async recover(): Promise<void> {
    await this.store.setState(this.id, "started");
  }

  async delete(): Promise<void> {
    try {
      if (this.state === "destroyed") return;
      const failure = await this.store.consumeDeleteFailure();
      if (failure !== undefined) {
        throw Object.assign(new Error(`Fake Daytona delete ${failure}`), {
          status: failure === "unavailable" ? 503 : 400,
        });
      }
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
            const stat = await handle.stat();
            // Слой обязан отличать отсутствие (null) от каталога (EISDIR).
            if (stat.isDirectory()) {
              throw Object.assign(new Error("EISDIR: path is a directory"), { code: "EISDIR" });
            }
            if (!stat.isFile()) throw new Error("Sandbox path is not a regular file");
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
        });
        await this.stop();
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

function lifecycleIntervals() {
  const config = loadConfig();
  return {
    autoStopInterval: config.sandboxIdleStopMinutes,
    autoArchiveInterval: config.sandboxArchiveAfterDays * 24 * 60,
  };
}

export function getFakeBackend(directory: string, apiKey: string, resources: FakeResources) {
  const store = new FakeStore(directory);
  return {
    async *list(): AsyncIterable<FakeMachine> {
      for (const record of await store.listMachines(apiKey)) yield new FakeMachineHandle(store, record);
    },
    get: async (idOrName: string): Promise<FakeMachine> => {
      const failure = await store.consumeGetFailure();
      if (failure !== undefined) {
        throw Object.assign(new Error(`Fake Daytona get ${failure}`), {
          status: failure === "unauthorized" ? 401 : 503,
        });
      }
      const record = (await store.listMachines(apiKey)).find((machine) =>
        machine.id === idOrName || machine.name === idOrName,
      );
      if (record === undefined) throw Object.assign(new Error("Fake Daytona: not found"), { status: 404 });
      return new FakeMachineHandle(store, record);
    },
    create: async ({ name, appSessionId }: { name: string; appSessionId: string }): Promise<FakeMachine> => {
      const { machine, failure } = await store.create(name, appSessionId, apiKey, resources, lifecycleIntervals());
      if (failure === "quota") {
        // Та же форма, по которой провайдер узнаёт исчерпанную квоту Daytona.
        throw Object.assign(new Error("Total CPU/memory/disk limit exceeded"), { status: 400 });
      }
      if (failure) {
        const status = failure === "unavailable" ? 503 : failure === "unauthorized" ? 401 : 400;
        throw Object.assign(new Error(`Fake Daytona ${failure}: dtn_test_secret_value`), {
          status,
          ...(machine ? { sandboxId: machine.id } : {}),
        });
      }
      if (!machine) throw new Error("Fake Daytona did not create a machine");
      return new FakeMachineHandle(store, machine);
    },
  };
}
