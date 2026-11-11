import { setTimeout as delay } from "node:timers/promises";
import { and, eq, gt } from "drizzle-orm";

import { getDb, getSqlClient } from "@/lib/db/client";
import { appSessions, sandboxes } from "@/lib/db/schema";

/** Начало шага ждёт уже принятую остановку вне транзакции и без соединения. */
export async function waitForSandboxMaintenance(appSessionId: string): Promise<void> {
  while (true) {
    const [row] = await getDb().select({ id: sandboxes.id }).from(sandboxes).where(and(
      eq(sandboxes.appSessionId, appSessionId), gt(sandboxes.maintenanceUntil, new Date()),
    ));
    if (!row) return;
    await delay(100);
  }
}

export async function recordSandboxWork(
  eveSessionId: string,
  state: "active" | "input" | "idle",
  turnId?: string,
  eventId?: string,
): Promise<void> {
  const [session] = await getDb().select({ id: appSessions.id }).from(appSessions)
    .where(eq(appSessions.eveSessionId, eveSessionId));
  if (!session) return;
  await getSqlClient().begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(20261111, hashtext(${session.id}))`;
    await tx`update app_sessions set sandbox_work_state = ${state},
      sandbox_work_turn_id = coalesce(${turnId ?? null}, sandbox_work_turn_id),
      sandbox_work_event_id = ${eventId ?? null}
      where id = ${session.id} and (${state} = 'active' or ${turnId ?? null}::text is null
        or sandbox_work_turn_id is null or sandbox_work_turn_id = ${turnId ?? null})`;
  });
  if (state === "active") await waitForSandboxMaintenance(session.id);
}
