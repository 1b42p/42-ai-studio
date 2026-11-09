import { and, asc, eq, gte } from "drizzle-orm";

import type { DaytonaMachine } from "@/agent/lib/daytona-backend";
import { getDb } from "@/lib/db/client";
import { bashJobs, sessionEvents } from "@/lib/db/schema";

const FRESH_EVENT_MS = 2 * 60_000;
const MAX_JOB_AGE_MS = 6 * 60 * 60_000;

interface BusyEvent {
  readonly payload: unknown;
  readonly createdAt: Date;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

/** События идут в порядке seq; явное ожидание и завершение важнее свежести. */
export function turnIsBusy(events: readonly BusyEvent[], now = Date.now()): boolean {
  let state: "unknown" | "active" | "input" | "idle" = "unknown";
  let turnId: string | undefined;
  let latestAt = -Infinity;

  for (const event of events) {
    const payload = record(event.payload);
    const data = record(payload.data);
    const type = payload.type;
    if (typeof type !== "string") continue;
    latestAt = event.createdAt.getTime();
    const eventTurnId = typeof data.turnId === "string" ? data.turnId : undefined;
    const sameTurn = turnId === undefined || eventTurnId === turnId;

    if (type === "turn.started") {
      turnId = eventTurnId;
      state = "active";
    } else if (
      type === "session.waiting" || type === "session.failed" || type === "session.completed"
    ) {
      state = "idle";
    } else if (
      (type === "turn.completed" || type === "turn.failed" || type === "turn.cancelled") && sameTurn
    ) {
      state = "idle";
    } else if (
      sameTurn && state !== "idle" &&
      type === "turn.waiting" && data.on === "input"
    ) {
      turnId ??= eventTurnId;
      state = "input";
    } else if (
      sameTurn && state !== "idle" &&
      (type === "input.resolved" || type === "step.started")
    ) {
      turnId ??= eventTurnId;
      state = "active";
    }
  }

  if (state === "idle" || state === "input") return false;
  if (state === "active") return true;
  return now - latestAt < FRESH_EVENT_MS;
}

/** Только чтение уже запущенной машины: start/getSandbox здесь не вызываются. */
export async function sessionIsBusy(
  appSessionId: string,
  machine: Pick<DaytonaMachine, "readJobDirectory"> & Partial<Pick<DaytonaMachine, "state">>,
  now = Date.now(),
): Promise<boolean> {
  const events = await getDb()
    .select({ payload: sessionEvents.payload, createdAt: sessionEvents.createdAt })
    .from(sessionEvents)
    .where(eq(sessionEvents.appSessionId, appSessionId))
    .orderBy(asc(sessionEvents.seq));
  if (turnIsBusy(events, now)) return true;
  if ("state" in machine && machine.state !== "started") return false;

  const jobs = await getDb().select({ jobId: bashJobs.jobId }).from(bashJobs).where(and(
    eq(bashJobs.appSessionId, appSessionId),
    eq(bashJobs.status, "running"),
    gte(bashJobs.createdAt, new Date(now - MAX_JOB_AGE_MS)),
  ));
  for (const job of jobs) {
    try {
      const reading = await machine.readJobDirectory(job.jobId);
      if (reading.found && reading.alive && reading.exitCode === null) return true;
    } catch {
      // Недоступность каталога не доказывает, что процесс завершился.
      return true;
    }
  }
  return false;
}
