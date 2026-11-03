/** Общие с браузером типы задания `bash`; без Node и Daytona. */

/** Eve создаёт каталог задания как `randomUUID().slice(0, 8)`. */
export const JOB_ID_PATTERN = /^[0-9a-f]{8}$/;

/** Последний сегмент `outputDirectory` результата `bash`, если это задание. */
export function jobIdFromDirectory(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const jobId = value.replace(/\/+$/, "").split("/").at(-1) ?? "";
  return JOB_ID_PATTERN.test(jobId) ? jobId : null;
}

export type JobStatus = "running" | "completed" | "interrupted";

/** Ответ `GET /api/sessions/:id/jobs/:jobId`. */
export interface BashJobResponse {
  readonly jobId: string;
  readonly status: JobStatus;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly truncated: boolean;
  readonly source: "sandbox" | "saved";
  readonly updatedAt: string;
}
