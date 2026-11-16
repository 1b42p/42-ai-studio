import { and, asc, eq, gt, sql } from "drizzle-orm";

import { getDb, getSqlClient } from "@/lib/db/client";
import { queueEntries, sandboxes } from "@/lib/db/schema";
import { recordSandboxTransition } from "@/lib/usage/sandbox";
import type { SandboxStatus } from "./status";

/** Единый порядок живой очереди для пользователя и оператора, без диспетчера. */
export async function queuePositions() {
  const entries = await getDb().select().from(queueEntries)
    .where(and(gt(queueEntries.heartbeatAt, new Date(Date.now() - 60_000)),
      sql`exists (select 1 from app_sessions where id = ${queueEntries.appSessionId} and deleted_at is null)`))
    .orderBy(asc(queueEntries.enqueuedAt), asc(queueEntries.id));
  return entries.map((entry, index) => ({ ...entry, position: index + 1 }));
}

/** Снимок очереди без обращения к Daytona или изменения состояния машины. */
export async function getSandboxStatus(appSessionId: string): Promise<SandboxStatus> {
  const entries = await queuePositions();
  const position = entries.findIndex((entry) => entry.appSessionId === appSessionId);
  if (position !== -1) {
    return {
      state: "queued",
      queue: { position: entries[position].position, total: entries.length, reason: entries[position].reason },
    };
  }
  const [sandbox] = await getDb().select({ state: sandboxes.state }).from(sandboxes)
    .where(eq(sandboxes.appSessionId, appSessionId)).limit(1);
  return { state: sandbox === undefined || sandbox.state === "gone" ? "none" : sandbox.state, queue: null };
}

/** Корневая сессия определяется через привязку eve, а не клиентский заголовок. */
export async function removeSandboxQueueEntry(eveSessionId: string, userId?: string, turnId?: string): Promise<void> {
  await getSqlClient().begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(20261110, 24)`;
    const [session] = await tx<{ id: string; generation: number }[]>`
      select id, sandbox_wait_generation as generation from app_sessions
      where eve_session_id = ${eveSessionId} and (${userId ?? null}::uuid is null or user_id = ${userId ?? null}::uuid)`;
    if (!session) return;
    if (turnId) {
      await tx`insert into sandbox_wait_turns (app_session_id, turn_id, generation)
        select id, ${turnId}, sandbox_wait_generation from app_sessions
        where id = ${session.id} and (sandbox_work_turn_id is null or sandbox_work_turn_id = ${turnId})
        on conflict (app_session_id, scope_id, turn_id) do nothing`;
      const [turn] = await tx<{ generation: number }[]>`
        select generation from sandbox_wait_turns where app_session_id = ${session.id}
          and scope_id = 'root' and turn_id = ${turnId}`;
      if (!turn || turn.generation !== session.generation) return;
    }
    await tx`update app_sessions set sandbox_wait_generation = sandbox_wait_generation + 1 where id = ${session.id}`;
    await tx`delete from queue_entries where app_session_id = ${session.id}
      and wait_generation = ${session.generation}`;
    // Запрос, уже отправленный Daytona, остаётся восстановимым по имени машины.
    const [reservation] = await tx<{ id: string; kind: string | null }[]>`
      select id, starting_kind as kind from sandboxes
      where app_session_id = ${session.id} and wait_generation = ${session.generation}
        and state = 'starting' and launch_started_at is null for update`;
    if (reservation) {
      await recordSandboxTransition({
        sandboxId: reservation.id, source: "app",
        newState: reservation.kind === "wake" ? "stopped" : reservation.kind === "restore" ? "archived" : "gone",
        changes: { slotRequestId: null, startingSince: null, startingKind: null },
      }, tx);
    }
  });
}
