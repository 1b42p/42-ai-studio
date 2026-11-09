import { spawn } from "node:child_process";
import { access, constants, readdir, stat } from "node:fs/promises";
import path from "node:path";

export interface ProcessResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export class ProcessLimitError extends Error {
  readonly limit: "timeout" | "too_large";
  readonly bytes: number | undefined;

  constructor(limit: "timeout" | "too_large", bytes?: number) {
    super(limit);
    this.name = "ProcessLimitError";
    this.limit = limit;
    this.bytes = bytes;
  }
}

const OUTPUT_CAP = 256 * 1024;

/** Окружение дочернего процесса: только то, без чего команда не найдёт свои программы. */
export function childEnv(home: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "",
    HOME: home,
    TMPDIR: home,
    LANG: "C.UTF-8",
  } as unknown as NodeJS.ProcessEnv;
}

export async function resolveExecutable(command: string): Promise<string | null> {
  if (command.includes("/") || command.includes("\\")) {
    const absolute = path.resolve(command);
    try {
      await access(absolute, constants.X_OK);
      return absolute;
    } catch {
      return null;
    }
  }
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (dir.length === 0) continue;
    const candidate = path.join(dir, command);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // следующий каталог PATH
    }
  }
  return null;
}

async function directorySize(root: string): Promise<number> {
  let total = 0;
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) total += await directorySize(full);
    else if (entry.isFile()) total += (await stat(full)).size;
  }
  return total;
}

function killGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // процесс уже завершился
    }
  }
}

/**
 * Запуск без оболочки, в своей группе процессов. Поток вывода обрезается,
 * каталог проверяется раз в секунду, отмена и срок убивают всю группу.
 */
export async function runCaptured(options: {
  readonly bin: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly signal: AbortSignal;
  readonly maxDirBytes?: number;
}): Promise<ProcessResult> {
  options.signal.throwIfAborted();
  const child = spawn(options.bin, [...options.args], {
    cwd: options.cwd,
    env: options.env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  const append = (current: string, chunk: Buffer) => {
    const next = current + chunk.toString("utf8");
    return next.length > OUTPUT_CAP ? next.slice(-OUTPUT_CAP) : next;
  };
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string | Buffer) => {
    stdout = append(stdout, Buffer.from(chunk));
  });
  child.stderr?.on("data", (chunk: string | Buffer) => {
    stderr = append(stderr, Buffer.from(chunk));
  });

  let limit: ProcessLimitError | null = null;
  const stopFor = (reason: "timeout" | "too_large", bytes?: number) => {
    if (limit !== null) return;
    limit = new ProcessLimitError(reason, bytes);
    killGroup(child.pid);
  };
  const onAbort = () => killGroup(child.pid);
  options.signal.addEventListener("abort", onAbort, { once: true });

  const sizeTimer = options.maxDirBytes === undefined
    ? undefined
    : setInterval(() => {
      void directorySize(options.cwd).then((bytes) => {
        if (options.maxDirBytes !== undefined && bytes > options.maxDirBytes) stopFor("too_large", bytes);
      }).catch(() => undefined);
    }, 1000);

  try {
    const exitCode = await new Promise<number>((resolve, reject) => {
      child.once("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") {
          reject(Object.assign(new Error("not_found"), { code: "ENOENT" }));
          return;
        }
        reject(error);
      });
      child.once("close", (code) => resolve(code ?? 1));
    });
    if (options.signal.aborted) {
      const reason = options.signal.reason;
      if (reason instanceof ProcessLimitError) throw reason;
      throw reason instanceof Error ? reason : Object.assign(new Error("Aborted"), { name: "AbortError" });
    }
    if (limit !== null) throw limit;
    return { stdout, stderr, exitCode };
  } finally {
    if (sizeTimer !== undefined) clearInterval(sizeTimer);
    options.signal.removeEventListener("abort", onAbort);
  }
}
