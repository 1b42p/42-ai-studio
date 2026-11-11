import { eq, sql } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import { appSessions, sandboxWorkers } from "@/lib/db/schema";
import { waitForSandboxMaintenance } from "@/lib/sandbox/maintenance";

/** Копии делят машину корня, но не состояние занятости друг друга. */
export async function recordSandboxCopyWork(
  rootEveSessionId: string,
  eveSessionId: string,
  state: "active" | "input" | "idle",
  turnId?: string,
  eventId?: string,
  turnSequence = 0,
): Promise<void> {
  const [session] = await getDb().select({ id: appSessions.id }).from(appSessions)
    .where(eq(appSessions.eveSessionId, rootEveSessionId));
  if (!session) return;

  await getDb().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(20261111, hashtext(${session.id}))`);
    await tx.insert(sandboxWorkers).values({
      appSessionId: session.id, eveSessionId, state,
      turnId: turnId ?? null, eventId: eventId ?? null, turnSequence,
    }).onConflictDoUpdate({
      target: sandboxWorkers.eveSessionId,
      set: {
        state,
        turnId: sql`coalesce(excluded.turn_id, ${sandboxWorkers.turnId})`,
        turnSequence,
        eventId: eventId ?? null,
      },
      // Sequence относится к сессии копии, а не к ходу её родителя.
      // Завершение старого хода не снимает новый active; повтор старого
      // начала не оживляет уже завершённый ход. Input, в отличие от idle,
      // разрешает продолжение того же хода после ответа пользователя.
      setWhere: sql`${sandboxWorkers.appSessionId} = excluded.app_session_id
        and excluded.turn_sequence >= ${sandboxWorkers.turnSequence}
        and (
          excluded.turn_sequence > ${sandboxWorkers.turnSequence}
          or (
            (${sandboxWorkers.turnId} is null or excluded.turn_id is null
              or ${sandboxWorkers.turnId} = excluded.turn_id)
            and not (${sandboxWorkers.state} = 'idle' and excluded.state <> 'idle')
          )
        )`,
    });
  });

  // Не держим соединение или блокировку, пока принятая остановка завершается.
  if (state === "active") await waitForSandboxMaintenance(session.id);
}
