/**
 * Чтение задания `bash` для маршрута (#11): сохранённый хвост из `bash_jobs`
 * или свежий разбор каталога в живой песочнице. Остановленную песочницу не
 * будим — задание без завершения становится `interrupted`.
 */
import { and, eq } from "drizzle-orm";

import { daytonaBackend, type DaytonaMachine } from "@/agent/lib/daytona-backend";
import { loadConfig } from "@/lib/config";
import { getDb } from "@/lib/db/client";
import { bashJobs, daytonaKeys, sandboxes, type BashJob, type Sandbox } from "@/lib/db/schema";
import { decryptSecret, DAYTONA_KEY_PURPOSE } from "@/lib/secrets";
import { sleep } from "@/lib/sleep";
import { savedJobResponse } from "./bash-jobs";
import { decodeTail, jobStatus, type JobDirectoryReading } from "./job-directory";
import { errorStatus, isMissingSandbox } from "./errors";
import type { BashJobResponse } from "./job-types";

export type BashJobResult =
  | { readonly kind: "ok"; readonly body: BashJobResponse }
  | { readonly kind: "not_found" }
  | { readonly kind: "unavailable" };

const CACHE_TTL_MS = 1000;
const CACHE_MAX_ENTRIES = 500;
/** Сколько раз перечитать строку: клиент может обогнать синхронизацию. */
const LOOKUP_ATTEMPTS = 3;
const LOOKUP_DELAY_MS = 200;
const ACTIVE_TOUCH_MS = 60_000;
const ACTIVE_WINDOW_MS = 6 * 60 * 60 * 1000;

/** Состояния, в которых песочницу уже не разбудить: задание прервано. */
const LOST_STATES: ReadonlySet<string> = new Set([
  "stopped", "stopping", "archived", "archiving", "destroyed", "destroying",
]);

/**
 * Один ответ на пару «сессия, задание» в секунду: вкладки не долбят Daytona.
 * Хранится промис, поэтому одновременные запросы тоже делят одно чтение.
 */
const cache = new Map<string, { expiresAt: number; readonly result: Promise<BashJobResult> }>();

export async function readBashJob(
  appSessionId: string,
  jobId: string,
): Promise<BashJobResult> {
  const key = `${appSessionId}:${jobId}`;
  const now = Date.now();
  const cached = cache.get(key);
  if (cached !== undefined && cached.expiresAt > now) return cached.result;
  if (cache.size >= CACHE_MAX_ENTRIES) {
    for (const [name, value] of cache) {
      if (value.expiresAt <= now) cache.delete(name);
    }
  }

  const entry = { expiresAt: now + CACHE_TTL_MS, result: loadBashJob(appSessionId, jobId) };
  cache.set(key, entry);
  let result: BashJobResult;
  try {
    result = await entry.result;
  } catch (error) {
    // Отклонённый промис не должен жить в кэше всю секунду.
    cache.delete(key);
    throw error;
  }
  if (result.kind !== "ok") {
    // Отказ не кэшируем: следующий опрос должен попробовать снова.
    cache.delete(key);
    return result;
  }
  entry.expiresAt = Date.now() + CACHE_TTL_MS;
  return result;
}

async function findJob(appSessionId: string, jobId: string): Promise<BashJob | null> {
  const [row] = await getDb()
    .select()
    .from(bashJobs)
    .where(and(eq(bashJobs.appSessionId, appSessionId), eq(bashJobs.jobId, jobId)))
    .limit(1);
  return row ?? null;
}

/**
 * Первый опрос может прийти раньше, чем синхронизатор сохранит `action.result`.
 * Несколько коротких повторов убирают эту гонку, не создавая строк из запроса.
 */
async function findJobForPoll(appSessionId: string, jobId: string): Promise<BashJob | null> {
  for (let attempt = 0; attempt < LOOKUP_ATTEMPTS; attempt += 1) {
    const job = await findJob(appSessionId, jobId);
    if (job !== null || attempt === LOOKUP_ATTEMPTS - 1) return job;
    await sleep(LOOKUP_DELAY_MS);
  }
  return null;
}

async function saveInterrupted(job: BashJob): Promise<BashJobResult> {
  const [updated] = await getDb()
    .update(bashJobs)
    .set({ status: "interrupted", updatedAt: new Date() })
    .where(and(eq(bashJobs.id, job.id), eq(bashJobs.status, "running")))
    .returning();
  if (updated !== undefined) return { kind: "ok", body: savedJobResponse(updated) };
  // Задание успело завершиться или строку удалили, пока мы шли к песочнице.
  const current = await findJob(job.appSessionId, job.jobId);
  return current === null ? { kind: "not_found" } : { kind: "ok", body: savedJobResponse(current) };
}

async function loadBashJob(appSessionId: string, jobId: string): Promise<BashJobResult> {
  const job = await findJobForPoll(appSessionId, jobId);
  if (job === null) return { kind: "not_found" };
  if (job.status !== "running") return { kind: "ok", body: savedJobResponse(job) };

  const [sandbox] = await getDb()
    .select()
    .from(sandboxes)
    .where(eq(sandboxes.appSessionId, appSessionId))
    .limit(1);
  if (sandbox === undefined) return { kind: "not_found" };
  if (sandbox.state === "gone") return { kind: "unavailable" };

  const [key] = await getDb()
    .select()
    .from(daytonaKeys)
    .where(eq(daytonaKeys.id, sandbox.daytonaKeyId))
    .limit(1);
  if (key === undefined || key.deletedAt !== null) return { kind: "unavailable" };

  let machine: DaytonaMachine;
  try {
    machine = await daytonaBackend(
      key.id,
      decryptSecret(key.apiKeyEncrypted, loadConfig().secretsEncryptionKey, DAYTONA_KEY_PURPOSE),
    ).get(sandbox.daytonaSandboxId);
  } catch (error) {
    if (isMissingSandbox(error)) return saveInterrupted(job);
    console.error("[jobs] не удалось получить песочницу", errorStatus(error));
    return { kind: "unavailable" };
  }

  // Не будим остановленную песочницу ради точного кода выхода. Пока машина
  // стартует или восстанавливается, это временная ошибка, а не прерывание.
  if (machine.state !== "started") {
    return LOST_STATES.has(machine.state ?? "") ? saveInterrupted(job) : { kind: "unavailable" };
  }

  let reading: JobDirectoryReading;
  try {
    reading = await machine.readJobDirectory(jobId);
  } catch (error) {
    console.error("[jobs] не удалось прочитать каталог задания", errorStatus(error));
    return { kind: "unavailable" };
  }
  if (!reading.found) return saveInterrupted(job);

  const status = jobStatus(reading);
  const stdout = decodeTail(reading.stdoutTail, reading.stdoutBytes);
  const stderr = decodeTail(reading.stderrTail, reading.stderrBytes);
  const [updated] = await getDb()
    .update(bashJobs)
    .set({
      status,
      exitCode: reading.exitCode,
      stdoutTail: stdout.text,
      stderrTail: stderr.text,
      stdoutBytes: reading.stdoutBytes,
      stderrBytes: reading.stderrBytes,
      updatedAt: new Date(),
    })
    .where(eq(bashJobs.id, job.id))
    .returning();
  if (updated === undefined) return { kind: "not_found" };

  await touchSandbox(sandbox, job, reading, status);
  return {
    kind: "ok",
    body: {
      ...savedJobResponse(updated),
      truncated: stdout.truncated || stderr.truncated,
      source: "sandbox",
    },
  };
}

/**
 * Продлевает занятость сессии, только пока задание живо и не дольше шести
 * часов с создания песочницы: вечный сервер с `&` не держит #24 навсегда.
 */
async function touchSandbox(
  sandbox: Sandbox,
  previous: BashJob,
  reading: { readonly stdoutBytes: number; readonly stderrBytes: number },
  status: ReturnType<typeof jobStatus>,
): Promise<void> {
  if (status !== "running") return;
  const now = Date.now();
  if (now - sandbox.createdAt.getTime() > ACTIVE_WINDOW_MS) return;
  const changed = reading.stdoutBytes !== previous.stdoutBytes || reading.stderrBytes !== previous.stderrBytes;
  const stale = now - sandbox.lastActiveAt.getTime() >= ACTIVE_TOUCH_MS;
  if (!changed && !stale) return;
  await getDb()
    .update(sandboxes)
    .set({ lastActiveAt: new Date(now) })
    .where(eq(sandboxes.id, sandbox.id));
}

