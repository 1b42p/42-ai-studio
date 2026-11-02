import { randomUUID } from "node:crypto";
import { constants, readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { emptyReading, JOB_TAIL_BYTES, type JobDirectoryReading } from "./job-directory";
import { JOB_ID_PATTERN } from "./job-types";

export type FakeCreateFailure = "build_failed" | "unavailable" | "error";
export interface FakeRule {
  match: RegExp | string;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  delayMs?: number;
}
export interface StoredRule extends Omit<FakeRule, "match"> {
  match: string;
  flags: string;
}
export interface FakeCall {
  op: "spawn" | "readFile" | "writeFiles" | "removePath" | "stop" | "readJobDirectory";
  command?: string;
  path?: string;
  at: number;
}
export interface FakeRecord {
  id: string;
  name: string;
  appSessionId: string;
  state: string;
  recoverable?: boolean;
  calls: FakeCall[];
  /** Задания, остановленные `fakeSandbox.killProcess`. */
  killedJobs?: string[];
}
export interface FakeCounters {
  created: number;
  started: number;
  stopped: number;
  deleted: number;
}
interface StoreData {
  machines: FakeRecord[];
  rules: StoredRule[];
  counters: FakeCounters;
  failNextCreate?: FakeCreateFailure;
}

function initialData(): StoreData {
  return {
    machines: [],
    rules: [],
    counters: { created: 0, started: 0, stopped: 0, deleted: 0 },
  };
}

export function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

/** Значение из одинарных кавычек нашей же команды; `'\''` — одна кавычка. */
function unquoteShell(value: string): string | null {
  if (value.length < 2 || !value.startsWith("'") || !value.endsWith("'")) return null;
  return value.slice(1, -1).replaceAll("'\\''", "'");
}

export function fakeNotFound(): Error & { status: number } {
  return Object.assign(new Error("Fake Daytona: not found (dtn_test_secret_value)"), {
    status: 404,
  });
}

/** Shared by the Next.js process, eve process, and HTTP-test worker. No cached state. */
export class FakeStore {
  readonly directory: string;

  constructor(directory: string) {
    if (!directory.trim()) throw new Error("Fake sandbox directory is required");
    this.directory = path.resolve(directory);
    if (this.directory === path.parse(this.directory).root) {
      throw new Error("Fake sandbox directory cannot be the filesystem root");
    }
  }

  async transaction<T>(
    action: (data: StoreData) => Promise<T> | T,
    signal?: AbortSignal,
  ): Promise<T> {
    signal?.throwIfAborted();
    await fs.mkdir(this.directory, { recursive: true });
    const lock = path.join(this.directory, ".lock");
    const deadline = Date.now() + 30_000;
    let handle;
    for (;;) {
      signal?.throwIfAborted();
      try {
        handle = await fs.open(lock, "wx", 0o600);
        break;
      } catch (error) {
        if (!hasCode(error, "EEXIST")) throw error;
        if (Date.now() >= deadline) throw new Error("Fake sandbox lock timed out");
        await delay(15, undefined, { signal });
      }
    }
    try {
      signal?.throwIfAborted();
      let data: StoreData;
      try {
        data = JSON.parse(await fs.readFile(path.join(this.directory, "state.json"), "utf8"));
      } catch (error) {
        if (!hasCode(error, "ENOENT")) throw error;
        data = initialData();
      }
      try {
        return await action(data);
      } finally {
        // Failed/aborted calls still belong in the journal. A failed batch may
        // also have written earlier files, matching SandboxConnection's contract.
        await this.atomicWrite(path.join(this.directory, "state.json"), JSON.stringify(data));
      }
    } finally {
      await handle.close();
      await fs.unlink(lock);
    }
  }

  async atomicWrite(filename: string, content: string | Uint8Array, signal?: AbortSignal) {
    signal?.throwIfAborted();
    await fs.mkdir(path.dirname(filename), { recursive: true });
    const temporary = `${filename}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, content, { flag: "wx", mode: 0o600, signal });
      signal?.throwIfAborted();
      await fs.rename(temporary, filename);
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }

  machineRoot(id: string): string {
    // IDs are generated here, not accepted as host path components.
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("Invalid fake sandbox id");
    return path.join(this.directory, "machines", id, "fs");
  }

  seedRoot(appSessionId: string): string {
    if (!appSessionId) throw new Error("App session id is required");
    // UUIDs retain their documented seeds/<app_session_id>/ layout. Encode
    // arbitrary identifiers so neither slashes nor dot segments escape it.
    return path.join(this.directory, "seeds", encodeURIComponent(appSessionId).replaceAll(".", "%2E"));
  }

  /** Resolve sandbox paths, never host paths; refuse symlinks in every component. */
  async filePath(root: string, sandboxPath: string): Promise<string> {
    if (sandboxPath.includes("\0")) throw new Error("Invalid sandbox path");
    const absolute = path.posix.resolve("/workspace", sandboxPath);
    const components = absolute.split("/").filter(Boolean);
    let current = root;
    for (const component of ["", ...components]) {
      current = path.join(current, component);
      try {
        if ((await fs.lstat(current)).isSymbolicLink()) {
          throw new Error("Symbolic links are not supported in fake sandbox paths");
        }
      } catch (error) {
        if (!hasCode(error, "ENOENT")) throw error;
      }
    }
    return current;
  }

  find(data: StoreData, idOrName: string): FakeRecord {
    const record = data.machines.find(
      (machine) => (machine.id === idOrName || machine.name === idOrName) && machine.state !== "destroyed",
    );
    if (!record) throw fakeNotFound();
    return record;
  }

  /**
   * Встроенные команды, которыми серверный код проверяет файл перед копией
   * (#8): `realpath` и `stat`. Авторские правила проверяются раньше, поэтому
   * особый случай (например, `realpath`, ведущий наружу) задаётся правилом.
   */
  async shellBuiltin(
    root: string,
    command: string,
  ): Promise<Pick<StoredRule, "stdout" | "stderr" | "exitCode"> | null> {
    const quoted = /'(?:[^']|'\\'')*'/;
    const realpath = new RegExp(`^realpath -- (${quoted.source})$`).exec(command);
    if (realpath !== null) {
      const sandboxPath = unquoteShell(realpath[1]!);
      if (sandboxPath === null) return null;
      const absolute = path.posix.resolve("/workspace", sandboxPath);
      const host = await this.filePath(root, sandboxPath);
      try {
        await fs.stat(path.dirname(host));
      } catch (error) {
        if (hasCode(error, "ENOENT") || hasCode(error, "ENOTDIR")) {
          return { stderr: `realpath: ${absolute}: No such file or directory\n`, exitCode: 1 };
        }
        throw error;
      }
      return { stdout: `${absolute}\n`, exitCode: 0 };
    }

    const stat = new RegExp(`^LC_ALL=C stat -c '%F\\|%s' -- (${quoted.source})$`).exec(command);
    if (stat !== null) {
      const sandboxPath = unquoteShell(stat[1]!);
      if (sandboxPath === null) return null;
      let info;
      try {
        info = await fs.stat(await this.filePath(root, sandboxPath));
      } catch (error) {
        if (hasCode(error, "ENOENT") || hasCode(error, "ENOTDIR")) {
          return { stderr: "stat: cannot stat: No such file or directory\n", exitCode: 1 };
        }
        throw error;
      }
      const kind = info.isDirectory()
        ? "directory"
        : info.isFile()
          ? info.size === 0
            ? "regular empty file"
            : "regular file"
          : "special file";
      return { stdout: `${kind}|${info.size}\n`, exitCode: 0 };
    }

    return null;
  }

  /** Atomic rename makes a synchronous getter see a complete, current snapshot. */
  snapshot(id: string): FakeRecord {
    const data: StoreData = JSON.parse(readFileSync(path.join(this.directory, "state.json"), "utf8"));
    const machine = data.machines.find((record) => record.id === id);
    if (!machine) throw fakeNotFound();
    return machine;
  }

  current(data: StoreData, appSessionId: string): FakeRecord | undefined {
    return data.machines.findLast(
      (machine) => machine.appSessionId === appSessionId && machine.state !== "destroyed",
    );
  }

  async setState(idOrName: string, state: string): Promise<FakeRecord> {
    return this.transaction(async (data) => {
      const machine = this.find(data, idOrName);
      if (machine.state !== state) {
        if (state === "started") data.counters.started++;
        if (state === "stopped") data.counters.stopped++;
        if (state === "destroyed") {
          await fs.rm(path.dirname(this.machineRoot(machine.id)), { recursive: true, force: true });
          data.counters.deleted++;
        }
        machine.state = state;
      }
      return machine;
    });
  }

  async seed(appSessionId: string, files: Record<string, string | Uint8Array>): Promise<void> {
    await this.transaction(async (data) => {
      const machine = this.current(data, appSessionId);
      const root = machine ? this.machineRoot(machine.id) : this.seedRoot(appSessionId);
      for (const [filename, content] of Object.entries(files)) {
        await this.atomicWrite(await this.filePath(root, filename), content);
      }
    });
  }

  async read(appSessionId: string, filename: string): Promise<Uint8Array | null> {
    return this.transaction(async (data) => {
      const machine = this.current(data, appSessionId);
      if (!machine) return null;
      try {
        return await fs.readFile(await this.filePath(this.machineRoot(machine.id), filename));
      } catch (error) {
        if (hasCode(error, "ENOENT")) return null;
        throw error;
      }
    });
  }

  async write(appSessionId: string, filename: string, content: string | Uint8Array): Promise<void> {
    await this.transaction(async (data) => {
      const machine = this.current(data, appSessionId);
      if (!machine) throw fakeNotFound();
      await this.atomicWrite(await this.filePath(this.machineRoot(machine.id), filename), content);
    });
  }

  async list(appSessionId: string, directory: string): Promise<string[]> {
    return this.transaction(async (data) => {
      const machine = this.current(data, appSessionId);
      if (!machine) return [];
      const root = this.machineRoot(machine.id);
      const start = await this.filePath(root, directory);
      const result: string[] = [];
      const visit = async (folder: string) => {
        for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
          const filename = path.join(folder, entry.name);
          if (entry.isSymbolicLink()) throw new Error("Symbolic links are not supported");
          result.push(`/${path.relative(root, filename).split(path.sep).join("/")}`);
          if (entry.isDirectory()) await visit(filename);
        }
      };
      try {
        await visit(start);
      } catch (error) {
        if (!hasCode(error, "ENOENT")) throw error;
      }
      return result.sort();
    });
  }

  /**
   * Каталог задания eve из фиктивной песочницы. Живость процесса здесь —
   * отсутствие `exit` и `killProcess`; отсутствие `pid` ещё не остановка,
   * как и в настоящем каталоге.
   */
  async readJobDirectory(machineId: string, jobId: string): Promise<JobDirectoryReading> {
    if (!JOB_ID_PATTERN.test(jobId)) throw new Error("Invalid fake job id");
    return this.transaction(async (data) => {
      const machine = data.machines.find((record) => record.id === machineId);
      if (machine === undefined || machine.state === "destroyed") throw fakeNotFound();
      machine.calls.push({ op: "readJobDirectory", path: `/tmp/.eve/jobs/${jobId}`, at: Date.now() });

      const directory = path.join(this.machineRoot(machine.id), "tmp", ".eve", "jobs", jobId);
      try {
        await fs.access(directory);
      } catch (error) {
        if (hasCode(error, "ENOENT")) return emptyReading();
        throw error;
      }

      const file = async (name: string): Promise<Uint8Array | null> => {
        try {
          return await fs.readFile(path.join(directory, name));
        } catch (error) {
          if (hasCode(error, "ENOENT")) return null;
          throw error;
        }
      };
      const text = (value: Uint8Array | null): string =>
        value === null ? "" : Buffer.from(value).toString("utf8").trim();

      const exit = text(await file("exit"));
      const killed = (machine.killedJobs ?? []).includes(jobId);
      const exitCode = /^-?\d+$/.test(exit) ? Number(exit) : null;
      // Каталог есть, а `pid` ещё нет — задание уже считается идущим.
      const alive = exitCode === null && !killed && machine.state === "started";

      const stdout = (await file("stdout")) ?? new Uint8Array();
      const stderr = (await file("stderr")) ?? new Uint8Array();
      return {
        found: true,
        exitCode,
        alive,
        stdoutTail: stdout.slice(Math.max(0, stdout.byteLength - JOB_TAIL_BYTES)),
        stderrTail: stderr.slice(Math.max(0, stderr.byteLength - JOB_TAIL_BYTES)),
        stdoutBytes: stdout.byteLength,
        stderrBytes: stderr.byteLength,
      };
    });
  }

  /** Останавливает процесс задания, не создавая файла `exit`. */
  async killProcess(appSessionId: string, jobId: string): Promise<void> {
    if (!JOB_ID_PATTERN.test(jobId)) throw new Error("Invalid fake job id");
    await this.transaction((data) => {
      const machine = this.current(data, appSessionId);
      if (machine === undefined) throw fakeNotFound();
      machine.killedJobs ??= [];
      if (!machine.killedJobs.includes(jobId)) machine.killedJobs.push(jobId);
    });
  }

  async calls(appSessionId: string): Promise<FakeCall[]> {
    return this.transaction((data) => data.machines
      .filter((machine) => machine.appSessionId === appSessionId)
      .flatMap((machine) => machine.calls)
      .sort((a, b) => a.at - b.at));
  }

  async stop(appSessionId: string): Promise<void> {
    await this.transaction((data) => {
      const machine = this.current(data, appSessionId);
      if (!machine) throw fakeNotFound();
      if (machine.state !== "stopped") {
        machine.state = "stopped";
        data.counters.stopped++;
      }
    });
  }

  async setRules(rules: readonly FakeRule[]): Promise<void> {
    const serialized = rules.map(({ match, ...rule }) => {
      const expression = typeof match === "string" ? new RegExp(match) : match;
      return { ...rule, match: expression.source, flags: expression.flags };
    });
    await this.transaction((data) => { data.rules = serialized; });
  }

  async failNextCreate(kind: FakeCreateFailure): Promise<void> {
    await this.transaction((data) => { data.failNextCreate = kind; });
  }

  async counters(): Promise<FakeCounters> {
    return this.transaction((data) => ({ ...data.counters }));
  }

  async reset(): Promise<void> {
    await this.transaction(async (data) => {
      // Keep the lock itself: deleting the root would admit a concurrent writer.
      for (const entry of ["machines", "seeds"]) {
        // Фиктивная песочница живёт только в тестах; динамический путь не
        // должен заставлять Turbopack трассировать весь проект.
        await fs.rm(path.join(/* turbopackIgnore: true */ this.directory, entry), {
          force: true,
          recursive: true,
        });
      }
      Object.assign(data, initialData());
      delete data.failNextCreate;
    });
  }

  async create(name: string, appSessionId: string): Promise<{ machine?: FakeRecord; failure?: FakeCreateFailure }> {
    return this.transaction(async (data) => {
      if (data.machines.some((machine) => machine.name === name && machine.state !== "destroyed")) {
        throw Object.assign(new Error("Fake Daytona: name exists (dtn_test_secret_value)"), { status: 409 });
      }
      const failure = data.failNextCreate;
      delete data.failNextCreate;
      if (failure === "unavailable" || failure === "error") return { failure };
      const machine: FakeRecord = {
        id: randomUUID(), name, appSessionId,
        state: failure === "build_failed" ? "build_failed" : "started",
        calls: [],
      };
      const root = this.machineRoot(machine.id);
      await fs.mkdir(path.join(root, "workspace"), { recursive: true });
      await fs.mkdir(path.join(root, "tmp"), { recursive: true });
      await fs.mkdir(path.join(root, "root"), { recursive: true });
      if (!failure) {
        const seed = this.seedRoot(appSessionId);
        try {
          await fs.access(seed, constants.F_OK);
          await fs.cp(seed, root, { recursive: true, dereference: false });
          // Consume only after a successful creation, never on a failed build.
          await fs.rm(seed, { recursive: true, force: true });
        } catch (error) {
          if (!hasCode(error, "ENOENT")) throw error;
        }
      }
      data.machines.push(machine);
      data.counters.created++;
      if (!failure) data.counters.started++;
      return { machine, failure };
    });
  }
}
