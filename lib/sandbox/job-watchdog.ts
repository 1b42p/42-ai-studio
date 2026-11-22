import { randomUUID } from "node:crypto";
import { and, asc, eq, gte, isNull, ne } from "drizzle-orm";

import { getDb, getSqlClient } from "@/lib/db/client";
import { appSessions, bashJobs, sandboxes } from "@/lib/db/schema";

import { errorStatus } from "./errors";
import { BASH_JOB_KEEPALIVE_MS } from "./job-directory";
import { observeBashJob } from "./job-service";

const WATCHDOG_ID = "00000000-0000-4000-8000-000000000011";
const INTERVAL_MS = 10_000; // Минимальный автостоп Daytona — одна минута.
const CONCURRENCY = 16;

/**
 * Строки задания переживают закрытие вкладки, отмену хода и перезапуск
 * приложения. Аренда отделена от диспетчера очереди и не держит соединение
 * Postgres во время обращений в Daytona.
 */
async function watchBashJobs(): Promise<void> {
  const db = getDb();
  const jobs = await db.select({
    job: {
      id: bashJobs.id, appSessionId: bashJobs.appSessionId, jobId: bashJobs.jobId,
      createdAt: bashJobs.createdAt, stdoutBytes: bashJobs.stdoutBytes, stderrBytes: bashJobs.stderrBytes,
    },
    sandbox: sandboxes,
  })
    .from(bashJobs)
    .innerJoin(sandboxes, eq(sandboxes.appSessionId, bashJobs.appSessionId))
    .innerJoin(appSessions, eq(appSessions.id, bashJobs.appSessionId))
    .where(and(eq(bashJobs.status, "running"), isNull(appSessions.deletedAt),
      ne(sandboxes.daytonaSandboxId, ""), ne(sandboxes.state, "gone"),
      gte(bashJobs.createdAt, new Date(Date.now() - BASH_JOB_KEEPALIVE_MS))))
    .orderBy(asc(bashJobs.updatedAt), asc(bashJobs.id));
  if (!jobs.length) return;

  const sql = getSqlClient();
  const token = randomUUID();
  const [lease] = await sql`
    insert into sandbox_dispatchers (id, lease_token, lease_until)
    values (${WATCHDOG_ID}, ${token}, now() + interval '30 seconds')
    on conflict (id) do update set lease_token = excluded.lease_token, lease_until = excluded.lease_until
    where sandbox_dispatchers.lease_until is null or sandbox_dispatchers.lease_until < now()
    returning id`;
  if (!lease) return;
  let ownsLease = true;
  const renewal = setInterval(() => {
    void sql`
      update sandbox_dispatchers set lease_until = now() + interval '30 seconds'
      where id = ${WATCHDOG_ID} and lease_token = ${token} and lease_until > now()
      returning id`.then((rows) => { ownsLease = rows.length !== 0; }, () => { ownsLease = false; });
  }, INTERVAL_MS);
  renewal.unref();

  try {
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(jobs.length, CONCURRENCY) }, async () => {
      while (ownsLease) {
        const candidate = jobs[next++];
        if (!candidate) return;
        const { job, sandbox } = candidate;
        try { await observeBashJob(job, sandbox, { keepAlive: true }); }
        catch (error) { console.warn("[jobs] watch_failed", errorStatus(error) ?? "internal"); }
      }
    }));
  } finally {
    clearInterval(renewal);
    await sql`update sandbox_dispatchers set lease_token = null, lease_until = null
      where id = ${WATCHDOG_ID} and lease_token = ${token}`;
  }
}

const runtime = globalThis as typeof globalThis & { __studioBashJobWatchdog?: boolean };

export function startBashJobWatchdog(): void {
  if (runtime.__studioBashJobWatchdog) return;
  runtime.__studioBashJobWatchdog = true;
  async function tick() {
    try { await watchBashJobs(); }
    catch (error) { console.warn("[jobs] watchdog_failed", errorStatus(error) ?? "internal"); }
    finally { setTimeout(() => void tick(), INTERVAL_MS).unref(); }
  }
  void tick();
}
