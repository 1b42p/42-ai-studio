/**
 * Задание eve `bash`: каталог `/tmp/.eve/jobs/<job_id>/` с файлами `stdout`,
 * `stderr`, `pid`, `exit` и `launcher`. Здесь только разбор того, что прочитал
 * слой песочницы, — без Daytona и базы.
 */
import type { Sandbox } from "@daytona/sdk";

import { StudioSandboxError } from "./errors";
import { JOB_ID_PATTERN, type JobStatus } from "./job-types";

/** Сколько байт хвоста каждого потока отдаёт маршрут (#11). */
export const JOB_TAIL_BYTES = 64 * 1024;

/** Прочитанное состояние каталога задания. */
export interface JobDirectoryReading {
  /** Каталог существует; иначе задания в песочнице уже нет. */
  readonly found: boolean;
  /** Код из `exit`; `null`, пока файла нет или он ещё пуст. */
  readonly exitCode: number | null;
  /** Группа процессов команды жива. */
  readonly alive: boolean;
  readonly stdoutTail: Uint8Array;
  readonly stderrTail: Uint8Array;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
}

/**
 * Статус по состоянию каталога. Файл `exit` пишется последним, поэтому его
 * наличие важнее живости процесса; мёртвый процесс без кода — `interrupted`.
 */
export function jobStatus(reading: Pick<JobDirectoryReading, "exitCode" | "alive">): JobStatus {
  if (reading.exitCode !== null) return "completed";
  return reading.alive ? "running" : "interrupted";
}

export interface DecodedTail {
  readonly text: string;
  readonly truncated: boolean;
}

/**
 * Хвост в текст: повреждённые байты заменяются. Если хвост короче всего
 * вывода и в нём есть перевод строки, первая неполная строка отбрасывается;
 * без перевода строки (прогресс через `\r`, длинный JSON) хвост остаётся.
 */
export function decodeTail(tail: Uint8Array, totalBytes: number): DecodedTail {
  const truncated = tail.byteLength < totalBytes;
  let bytes = tail;
  if (truncated) {
    const newline = tail.indexOf(0x0a);
    if (newline >= 0) bytes = tail.subarray(newline + 1);
  }
  return { text: new TextDecoder().decode(bytes), truncated };
}

export function emptyReading(found = false): JobDirectoryReading {
  return {
    found,
    exitCode: null,
    alive: false,
    stdoutTail: new Uint8Array(),
    stderrTail: new Uint8Array(),
    stdoutBytes: 0,
    stderrBytes: 0,
  };
}

function quote(value: string): string {
  if (value.includes("\0")) throw new Error("Недопустимый нулевой байт в команде.");
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Один разбор каталога; `studio-job:` — заголовок с полями, дальше base64. */
const JOB_SCRIPT = (jobId: string) => `d=/tmp/.eve/jobs/${quote(jobId)}
if [ ! -d "$d" ]; then printf 'studio-job:missing\\n'; exit 0; fi
cd "$d" || { printf 'studio-job:missing\\n'; exit 0; }
code=
if [ -s exit ]; then IFS= read -r code < exit || code=; fi
alive=0
if [ -z "$code" ]; then
  if [ ! -f pid ]; then
    alive=1
  else
    p=$(cat pid 2>/dev/null)
    if [ -n "$p" ] && kill -0 -- "-$p" 2>/dev/null; then alive=1; fi
  fi
  if [ "$alive" -eq 0 ]; then
    code=
    if [ -s exit ]; then IFS= read -r code < exit || code=; fi
  fi
fi
out=0; [ ! -f stdout ] || out=$(wc -c < stdout)
err=0; [ ! -f stderr ] || err=$(wc -c < stderr)
printf 'studio-job:%s:%s:%s:%s\\n' "$code" "$alive" "$out" "$err"
printf 'studio-job-stdout\\n'
if [ -f stdout ]; then tail -c ${JOB_TAIL_BYTES} stdout | base64 -w 0; fi
printf '\\nstudio-job-stderr\\n'
if [ -f stderr ]; then tail -c ${JOB_TAIL_BYTES} stderr | base64 -w 0; fi
printf '\\n'`;

function parseJobDirectory(output: string): JobDirectoryReading {
  if (output.startsWith("studio-job:missing")) return emptyReading();

  const [header, stdoutMarker, stdoutLine, stderrMarker, stderrLine] =
    output.split("\n");
  if (
    header === undefined ||
    !header.startsWith("studio-job:") ||
    stdoutMarker !== "studio-job-stdout" ||
    stderrMarker !== "studio-job-stderr"
  ) {
    throw new StudioSandboxError("daytona_unavailable");
  }

  const fields = header.slice("studio-job:".length).split(":");
  if (fields.length !== 4) throw new StudioSandboxError("daytona_unavailable");
  const [code, alive, stdoutBytes, stderrBytes] = fields;
  const numbers = [alive, stdoutBytes, stderrBytes].map((value) => Number(value));
  if (numbers.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    throw new StudioSandboxError("daytona_unavailable");
  }
  const exitCode = code === "" ? null : Number(code);
  if (exitCode !== null && !Number.isSafeInteger(exitCode)) {
    throw new StudioSandboxError("daytona_unavailable");
  }

  return {
    found: true,
    exitCode,
    alive: numbers[0] === 1,
    stdoutTail: Buffer.from(stdoutLine ?? "", "base64"),
    stderrTail: Buffer.from(stderrLine ?? "", "base64"),
    stdoutBytes: numbers[1]!,
    stderrBytes: numbers[2]!,
  };
}

/** Читает каталог задания из настоящей песочницы одной короткой командой. */
export async function readDaytonaJobDirectory(
  sandbox: Sandbox,
  jobId: string,
): Promise<JobDirectoryReading> {
  if (!JOB_ID_PATTERN.test(jobId)) throw new Error("Некорректный идентификатор задания.");
  try {
    const response = await sandbox.process.executeCommand(JOB_SCRIPT(jobId), undefined, undefined, 30);
    if (response.exitCode !== 0) throw new StudioSandboxError("daytona_unavailable");
    return parseJobDirectory(response.result);
  } catch (error) {
    if (error instanceof StudioSandboxError) throw error;
    throw new StudioSandboxError("daytona_unavailable");
  }
}
