/**
 * Запуск экземпляров приложения из тестов и общение с ними по HTTP.
 *
 * Каждый экземпляр получает свой `NEXT_DIST_DIR` (`.next-test-<порт>`), поэтому
 * `next dev` не спотыкается о блокировку `.next/dev/lock`, и свободный порт из
 * диапазона `TEST_APP_PORT`…`TEST_APP_PORT+99`.
 */
import { spawn, type ChildProcess } from "node:child_process";
import {
  createWriteStream,
  mkdirSync,
  readFileSync,
  writeFileSync,
  type WriteStream,
} from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { inject } from "vitest";

import { loadConfig, loadDotenvFiles } from "../../../lib/config";

declare module "vitest" {
  interface ProvidedContext {
    appUrl: string;
  }
}

/** Куда глобальная подготовка пишет вывод основного экземпляра. */
export const APP_LOG_FILE = ".tmp/http-test-app.log";

const READY_TIMEOUT_MS = 240_000;

export interface StartAppOptions {
  /** Переменные, перекрывающие значения из `.env.test`; `undefined` удаляет. */
  env?: Record<string, string | undefined>;
  /** Порт; по умолчанию берётся свободный из диапазона тестовых портов. */
  port?: number;
  /** Ждать завершения процесса вместо готовности. */
  expectExit?: boolean;
  /**
   * Предел ожидания готовности (при `expectExit` — завершения) в миллисекундах.
   * По умолчанию 240000.
   */
  readyTimeoutMs?: number;
  /** Расширение: дописывать вывод экземпляра в файл (нужно `appOutput()`). */
  logFile?: string;
}

export interface AppHandle {
  url: string;
  port: number;
  stop(): Promise<void>;
  output(): string;
  exited: Promise<number | null>;
}

/** Внутренняя форма: знает код завершения сразу после выхода процесса. */
interface InternalHandle extends AppHandle {
  exitCode?: number | null;
}

const projectRoot = path.resolve(fileURLToPath(new URL("../../../", import.meta.url)));

/** Заглушка внешнего каталога моделей для дочернего процесса приложения. */
const OFFLINE_GATEWAY_MODULE = path.join(projectRoot, "tests/http/support/offline-gateway.mjs");

function nextBin(): string {
  return path.join(projectRoot, "node_modules", "next", "dist", "bin", "next");
}

function testAppPort(): number {
  return loadConfig().testAppPort;
}

/**
 * Значения `.env.test` (и `.env.test.local`, если разработчик завёл) —
 * передаются дочернему процессу явно, чтобы его собственный `.env.local`
 * их не перебил.
 */
export function testEnvValues(): Record<string, string> {
  const merged: Record<string, string> = {};
  // Порядок загрузки: .local важнее .env.test — накладываем в обратном.
  for (const file of [...loadDotenvFiles()].reverse()) {
    const name = path.basename(file.path);
    if (name === ".env.test" || name === ".env.test.local") {
      Object.assign(merged, file.env);
    }
  }
  return merged;
}

function buildChildEnv(
  overrides: Record<string, string | undefined> | undefined,
  distDir: string,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    ...testEnvValues(),
  };
  for (const [name, value] of Object.entries(overrides ?? {})) {
    if (value === undefined) delete env[name];
    else env[name] = value;
  }
  // Дочерний next dev обязан получить NODE_ENV=development: dev-сервер eve
  // поднимается только в development.
  env.NODE_ENV = "development";
  env.NEXT_DIST_DIR = distDir;
  // Внешний каталог моделей не должен влиять на время старта тестов.
  const offlineGateway = `--import=${pathToFileURL(OFFLINE_GATEWAY_MODULE).href}`;
  env.NODE_OPTIONS =
    env.NODE_OPTIONS === undefined ? offlineGateway : `${env.NODE_OPTIONS} ${offlineGateway}`;
  return env;
}

function canBind(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
  });
}

/** Свободный порт из диапазона тестовых портов приложения. */
async function findFreePort(): Promise<number> {
  const from = testAppPort();
  for (let port = from; port <= from + 99; port++) {
    if (await canBind(port)) return port;
  }
  throw new Error(`Свободного порта в диапазоне ${from}…${from + 99} не нашлось`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Ждёт, пока `GET /api/health` начнёт отвечать: у здорового приложения это
 * `200`, при сломанных проверках — `503`. Оба означают, что сервер поднялся.
 */
async function waitUntilUp(handle: InternalHandle, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = "сервер не отвечал";
  while (Date.now() < deadline) {
    if (handle.exitCode !== undefined) {
      throw new Error(
        `Приложение завершилось до готовности (код ${handle.exitCode}):\n${handle.output()}`,
      );
    }
    try {
      const response = await fetch(`${handle.url}/api/health`, { redirect: "manual" });
      if (response.status === 200 || response.status === 503) return;
      last = `получен статус ${response.status}`;
    } catch (error) {
      last = String(error);
    }
    await sleep(500);
  }
  throw new Error(`Приложение не поднялось за ${timeoutMs} мс (${last}):\n${handle.output()}`);
}

export async function startApp(options: StartAppOptions = {}): Promise<AppHandle> {
  const config = loadConfig();
  const port = options.port ?? (await findFreePort());
  const distDir = `.next-test-${port}`;
  const url = `http://localhost:${port}`;
  // Отдельный tsconfig экземпляра (см. next.config.ts): Next.js дописывает в
  // него свои пути, корневой tsconfig.json остаётся нетронутым.
  writeFileSync(
    path.join(projectRoot, `${distDir}.tsconfig.json`),
    `${JSON.stringify({ extends: "./tsconfig.json" }, null, 2)}\n`,
  );

  let log: WriteStream | undefined;
  if (options.logFile !== undefined) {
    mkdirSync(path.dirname(path.join(projectRoot, options.logFile)), { recursive: true });
    log = createWriteStream(path.join(projectRoot, options.logFile), { flags: "a" });
  }

  const child: ChildProcess = spawn(
    process.execPath,
    [nextBin(), "dev", "--port", String(port)],
    {
      cwd: projectRoot,
      env: buildChildEnv(options.env, distDir) as NodeJS.ProcessEnv,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let output = "";
  const collect = (chunk: Buffer | string) => {
    output += chunk;
    log?.write(chunk);
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);

  let exitCode: number | null | undefined;
  const exited = new Promise<number | null>((resolve) => {
    child.once("exit", (code) => {
      exitCode = code;
      log?.end();
      resolve(code);
    });
    child.once("error", (error) => {
      output += String(error);
      exitCode = -1;
      log?.end();
      resolve(-1);
    });
  });

  const stop = async (): Promise<void> => {
    if (exitCode !== undefined) return;
    child.kill("SIGTERM");
    const stopped = await Promise.race([exited.then(() => true), sleep(10_000).then(() => false)]);
    if (!stopped) {
      child.kill("SIGKILL");
      await exited;
    }
  };

  const handle: InternalHandle = {
    url,
    port,
    output: () => output,
    exited,
    stop,
    get exitCode() {
      return exitCode;
    },
  };

  const timeoutMs = options.readyTimeoutMs ?? READY_TIMEOUT_MS;

  if (options.expectExit === true) {
    const finished = await Promise.race([
      exited.then(() => true),
      sleep(timeoutMs).then(() => false),
    ]);
    if (!finished) {
      await stop();
      throw new Error(`Приложение не завершилось за ${timeoutMs} мс:\n${output}`);
    }
    return handle;
  }

  try {
    await waitUntilUp(handle, timeoutMs);
  } catch (error) {
    // Иначе процесс остался бы занимать порт.
    await stop();
    throw error;
  }
  return handle;
}

/** Запрос к основному экземпляру; редиректы не выполняются. */
export function fetchApp(pathname: string, init?: RequestInit): Promise<Response> {
  return fetch(new URL(pathname, inject("appUrl")), { ...init, redirect: "manual" });
}

/** Весь вывод основного экземпляра за время тестов (stdout и stderr). */
export function appOutput(): string {
  return readFileSync(path.join(projectRoot, APP_LOG_FILE), "utf8");
}
