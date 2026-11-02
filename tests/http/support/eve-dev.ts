/**
 * Отдельный сервер eve для тестов, которым нужно своё окружение процесса eve
 * (#8: предел размера файла читается хуком в процессе eve, а общий dev-сервер
 * приложения один на проект и запускается окружением основного экземпляра).
 */
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { sleep } from "../../../lib/sleep";
import { testEnvValues } from "./app";

const projectRoot = path.resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]/g;

export interface EveDevServer {
  url: string;
  stop(): Promise<void>;
  output(): string;
}

/**
 * Запускает `eve dev` с переопределённым окружением и ждёт адрес сервера.
 * Состояние сессий — в отдельном `EVE_DEV_STATE_DIR`, чтобы не делить файлы
 * с основным экземпляром.
 */
export async function startEveDev(
  env: Record<string, string>,
  options: { timeoutMs?: number } = {},
): Promise<EveDevServer> {
  const timeoutMs = options.timeoutMs ?? 240_000;
  const child: ChildProcess = spawn(
    process.execPath,
    [path.join(projectRoot, "node_modules", "eve", "bin", "eve.js"), "dev", "--no-ui", "--port", "0"],
    {
      cwd: projectRoot,
      env: {
        ...process.env,
        ...testEnvValues(),
        EVE_DEV: "1",
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let output = "";
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`eve dev не напечатал адрес за ${timeoutMs} мс:\n${output}`));
    }, timeoutMs);

    const onData = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      const match = /server listening at\s+(https?:\/\/[^\s"']+)/i.exec(output.replace(ANSI, ""));
      if (match?.[1] === undefined) return;
      clearTimeout(timer);
      // Слушатели остаются: они продолжают вычитывать вывод, иначе процесс
      // eve заблокируется на заполненном канале.
      resolve(match[1]);
    };

    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`eve dev завершился до готовности (код ${code}):\n${output}`));
    });
  });

  return {
    url,
    output: () => output,
    async stop() {
      if (child.exitCode !== null) return;
      child.kill("SIGTERM");
      const stopped = await Promise.race([
        new Promise<boolean>((resolve) => child.once("exit", () => resolve(true))),
        sleep(10_000).then(() => false),
      ]);
      if (!stopped) {
        child.kill("SIGKILL");
        await new Promise((resolve) => child.once("exit", resolve));
      }
    },
  };
}
