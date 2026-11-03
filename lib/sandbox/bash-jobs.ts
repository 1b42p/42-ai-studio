/**
 * Фоновые команды `bash` в потоке eve (#11): разбор результата вызова и
 * форма ответа маршрута. Строку `bash_jobs` создаёт синхронизатор событий
 * по `action.result` со статусом `running` — так задание остаётся в базе,
 * даже если вкладка закрыта или синхронизация повторилась.
 */
import type { MessageStreamEvent } from "eve/client";

import type { BashJob } from "@/lib/db/schema";
import { jobIdFromDirectory, type BashJobResponse } from "./job-types";

export interface RunningBashJob {
  readonly jobId: string;
  readonly stdout: string;
  readonly stderr: string;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Результат `bash` со статусом `running`: `outputDirectory` — каталог
 * `/tmp/.eve/jobs/<8 hex>/`. Всё остальное не задание.
 */
export function runningBashJob(event: MessageStreamEvent): RunningBashJob | null {
  if (event.type !== "action.result" || event.data.status !== "completed") return null;
  const result = event.data.result;
  if (result.kind !== "tool-result" || result.toolName !== "bash" || result.isError === true) {
    return null;
  }
  if (typeof result.output !== "object" || result.output === null) return null;

  const output = result.output as Record<string, unknown>;
  if (output.status !== "running") return null;
  const jobId = jobIdFromDirectory(output.outputDirectory);
  if (jobId === null) return null;
  return { jobId, stdout: text(output.stdout), stderr: text(output.stderr) };
}

/** Сохранённое задание в форме ответа; песочница не нужна. */
export function savedJobResponse(row: BashJob): BashJobResponse {
  return {
    jobId: row.jobId,
    status: row.status,
    exitCode: row.exitCode,
    stdout: row.stdoutTail,
    stderr: row.stderrTail,
    stdoutBytes: row.stdoutBytes,
    stderrBytes: row.stderrBytes,
    truncated:
      Buffer.byteLength(row.stdoutTail) < row.stdoutBytes ||
      Buffer.byteLength(row.stderrTail) < row.stderrBytes,
    source: "saved",
    updatedAt: row.updatedAt.toISOString(),
  };
}
