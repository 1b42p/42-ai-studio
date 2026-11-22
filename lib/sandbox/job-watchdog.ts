import { randomUUID } from "node:crypto";
import { and, asc, eq, gte, isNull, ne } from "drizzle-orm";

import { getDb, getSqlClient } from "@/lib/db/client";
import { appSessions, bashJobs, sandboxes } from "@/lib/db/schema";

import { errorStatus } from "./errors";
import { BASH_JOB_KEEPALIVE_MS } from "./job-directory";
import { keepBashJobsAlive, observeBashJob } from "./job-service";

const WATCHDOG_ID = "00000000-0000-4000-8000-000000000011";
const DISCOVERY_MS = 5_000;
const OBSERVATION_MS = 10_000;
const KEEPALIVE_MS = 15_000; // Минимальный автостоп Daytona — одна минута.
const LEASE_MS = 30_000;
const OUTPUT_CONCURRENCY = 16;
const KEEPALIVE_CONCURRENCY = 32;

function findJobs() {
  const db = getDb();
  return db.select({
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
}

type Candidate = Awaited<ReturnType<typeof findJobs>>[number];

function lane<T>(
  concurrency: number, interval: number, stillLeased: () => boolean,
  run: (item: T) => Promise<unknown>, errorCode: string,
) {
  let entries: Array<{ group: string; item: T; dueAt: number }> = [];
  let byId = new Map<string, (typeof entries)[number]>();
  const runningGroups = new Set<string>();

  function dispatch() {
    if (runningGroups.size >= concurrency || !stillLeased()) return;
    const now = performance.now();
    entries.sort((a, b) => a.dueAt - b.dueAt);
    for (const entry of entries) {
      if (entry.dueAt > now || runningGroups.size >= concurrency || !stillLeased()) break;
      if (runningGroups.has(entry.group)) continue;
      entry.dueAt = now + interval;
      runningGroups.add(entry.group);
      void run(entry.item)
        .catch((error) => { console.warn("[jobs]", errorCode, errorStatus(error) ?? "internal"); })
        .finally(() => {
          runningGroups.delete(entry.group);
          dispatch();
        });
    }
  }

  return {
    get busy() { return runningGroups.size > 0; },
    schedule(items: Array<{ id: string; group: string; item: T }>) {
      const now = performance.now();
      const next = new Map<string, (typeof entries)[number]>();
      for (const { id, group, item } of items) {
        next.set(id, { group, item, dueAt: byId.get(id)?.dueAt ?? now });
      }
      byId = next;
      entries = [...next.values()];
      dispatch();
    },
  };
}

const runtime = globalThis as typeof globalThis & { __studioBashJobWatchdog?: boolean };

/** Аренда не держит соединение Postgres и продлевается независимо от сети. */
export function startBashJobWatchdog(): void {
  if (runtime.__studioBashJobWatchdog) return;
  runtime.__studioBashJobWatchdog = true;
  const token = randomUUID();
  let validUntil = -Infinity;
  const stillLeased = () => performance.now() < validUntil;
  // У чтения хвостов и проверки живости разные бюджеты. В каждом — не
  // более одного запроса за раз на машину, даже при десятках её заданий.
  const output = lane<Candidate>(OUTPUT_CONCURRENCY, OBSERVATION_MS, stillLeased,
    ({ job, sandbox }) => observeBashJob(job, sandbox), "watch_failed");
  const activity = lane<{ sandbox: Candidate["sandbox"]; jobs: string[] }>(KEEPALIVE_CONCURRENCY, KEEPALIVE_MS, stillLeased,
    ({ sandbox, jobs }) => keepBashJobsAlive(sandbox, jobs, stillLeased), "activity_failed");

  async function tick() {
    try {
      const jobs = await findJobs();
      const busy = output.busy || activity.busy;
      const sql = getSqlClient();
      if (!jobs.length && !busy) {
        const hadLease = stillLeased();
        validUntil = -Infinity;
        output.schedule([]);
        activity.schedule([]);
        if (hadLease) await sql`update sandbox_dispatchers set lease_token = null, lease_until = null
          where id = ${WATCHDOG_ID} and lease_token = ${token}`;
        return;
      }

      // При истечении/потере аренды не начинаем новых запросов, пока не
      // вернутся старые. Токен не может продлить аренду другого процесса.
      if (!stillLeased() && busy) return;
      const now = performance.now();
      const [lease] = await sql`
        insert into sandbox_dispatchers (id, lease_token, lease_until)
        values (${WATCHDOG_ID}, ${token}, now() + interval '30 seconds')
        on conflict (id) do update set lease_token = excluded.lease_token, lease_until = excluded.lease_until
        where sandbox_dispatchers.lease_token = ${token}
          or sandbox_dispatchers.lease_until is null or sandbox_dispatchers.lease_until <= now()
        returning id`;
      validUntil = lease ? now + LEASE_MS : -Infinity;
      if (!stillLeased()) return;

      const machines = new Map<string, { sandbox: Candidate["sandbox"]; jobs: string[] }>();
      for (const { job, sandbox } of jobs) {
        if (sandbox.state !== "started") continue;
        let item = machines.get(sandbox.id);
        if (!item) {
          item = { sandbox, jobs: [] };
          machines.set(sandbox.id, item);
        }
        item.jobs.push(job.jobId);
      }
      activity.schedule([...machines].map(([group, item]) => ({
        id: `${group}:${item.sandbox.daytonaSandboxId}:${item.sandbox.runningSince?.getTime() ?? ""}`, group, item,
      })));
      output.schedule(jobs.map((item) => ({ id: item.job.id, group: item.sandbox.id, item })));
    } catch (error) {
      validUntil = -Infinity;
      console.warn("[jobs] watchdog_failed", errorStatus(error) ?? "internal");
    } finally {
      setTimeout(() => void tick(), DISCOVERY_MS).unref();
    }
  }
  void tick();
}
