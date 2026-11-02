/** Сессия фиктивной песочницы для проверок серверных функций (#8). */
import { randomUUID } from "node:crypto";
import type {
  SandboxReadFileOptions,
  SandboxRunOptions,
  SandboxSession,
} from "eve/sandbox";

import { loadConfig } from "../../../lib/config";
import { getFakeBackend, type FakeMachine } from "../../../lib/sandbox/fake";

/** Минимальная сессия: копированию нужны `run` и `readFile`. */
export function sandboxSessionFrom(machine: FakeMachine): SandboxSession {
  const connection = machine.connect({ onActivity: async () => {}, onStop: async () => {} });
  return {
    async run({ command, abortSignal }: SandboxRunOptions) {
      const process = await connection.spawn({
        command,
        abortSignal,
        env: {},
        workingDirectory: "/workspace",
      });
      const [stdout, stderr, result] = await Promise.all([
        new Response(process.stdout).text(),
        new Response(process.stderr).text(),
        process.wait(),
      ]);
      return { exitCode: result.exitCode, stderr, stdout };
    },
    readFile: (options: SandboxReadFileOptions) => connection.readFile(options),
  } as unknown as SandboxSession;
}

/** Машина фиктивной песочницы для сессии приложения. */
export async function fakeMachineFor(appSessionId: string): Promise<FakeMachine> {
  const backend = getFakeBackend(loadConfig().fakeSandboxDir!);
  return backend.create({
    name: `media-${randomUUID()}`,
    appSessionId,
  });
}
