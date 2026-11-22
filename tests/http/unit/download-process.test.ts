import { tmpdir } from "node:os";

import { expect, test } from "vitest";

import { childEnv, runCaptured } from "../../../lib/download/process";

function write(script: string, fullStdoutMaxBytes?: number) {
  const cwd = tmpdir();
  return runCaptured({
    bin: process.execPath,
    args: ["-e", script],
    cwd,
    env: childEnv(cwd),
    signal: AbortSignal.timeout(5_000),
    fullStdoutMaxBytes,
  });
}

test("метаданные больше диагностического хвоста сохраняются целиком", async () => {
  const script = `process.stdout.write(JSON.stringify({ description: "я".repeat(400_000) }))`;
  const result = await write(script, 1024 * 1024);
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ description: "я".repeat(400_000) });
});

test("превышение лимита полного вывода определяется по байтам UTF-8", async () => {
  await expect(write(`process.stdout.write("я".repeat(1024))`, 1500)).rejects.toMatchObject({
    limit: "stdout_too_large",
  });
});
