/**
 * Разбор каталога задания для настоящей песочницы (#11). HTTP-тесты идут
 * через фиктивную песочницу, поэтому ответ Daytona проверяется здесь.
 */
import type { Sandbox } from "@daytona/sdk";
import { describe, expect, test, vi } from "vitest";

import {
  jobStatus,
  readDaytonaJobDirectory,
} from "../../lib/sandbox/job-directory";

function sandboxReturning(result: string, exitCode = 0): Sandbox {
  return {
    process: {
      executeCommand: vi.fn(async () => ({ exitCode, result })),
    },
  } as unknown as Sandbox;
}

function line(value: string): string {
  return Buffer.from(value).toString("base64");
}

describe("readDaytonaJobDirectory", () => {
  test("разбирает маркеры, размеры и base64-хвосты", async () => {
    const result = [
      "studio-job:0:1:1234:7",
      "studio-job-stdout",
      line("готово\n"),
      "studio-job-stderr",
      line("шум"),
      "",
    ].join("\n");

    const reading = await readDaytonaJobDirectory(sandboxReturning(result), "3f9a1c2e");
    expect(reading).toMatchObject({
      found: true,
      exitCode: 0,
      alive: true,
      stdoutBytes: 1234,
      stderrBytes: 7,
    });
    expect(Buffer.from(reading.stdoutTail).toString()).toBe("готово\n");
    expect(Buffer.from(reading.stderrTail).toString()).toBe("шум");
    expect(jobStatus(reading)).toBe("completed");
  });

  test("пустой exit и живой процесс — running, пустой exit и мёртвый — interrupted", async () => {
    const running = [
      "studio-job::1:10:0",
      "studio-job-stdout",
      line("x"),
      "studio-job-stderr",
      "",
      "",
    ].join("\n");
    expect(jobStatus(await readDaytonaJobDirectory(sandboxReturning(running), "3f9a1c2e")))
      .toBe("running");

    const dead = [
      "studio-job::0:10:0",
      "studio-job-stdout",
      line("x"),
      "studio-job-stderr",
      "",
      "",
    ].join("\n");
    const reading = await readDaytonaJobDirectory(sandboxReturning(dead), "3f9a1c2e");
    expect(reading.exitCode).toBeNull();
    expect(jobStatus(reading)).toBe("interrupted");
  });

  test("отсутствующий каталог — found: false", async () => {
    const reading = await readDaytonaJobDirectory(
      sandboxReturning("studio-job:missing\n"),
      "3f9a1c2e",
    );
    expect(reading.found).toBe(false);
  });

  test("сдвиг маркеров и неверный идентификатор — ошибка песочницы", async () => {
    const shifted = [
      "studio-job:0:1:0:0",
      line("не тот маркер"),
      "studio-job-stdout",
      "",
      "",
      "",
    ].join("\n");
    await expect(readDaytonaJobDirectory(sandboxReturning(shifted), "3f9a1c2e"))
      .rejects.toMatchObject({ code: "daytona_unavailable" });
    await expect(readDaytonaJobDirectory(sandboxReturning(""), "../etc"))
      .rejects.toThrow("Некорректный идентификатор задания");
  });
});
