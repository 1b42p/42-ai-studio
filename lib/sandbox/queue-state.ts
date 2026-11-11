import { and, asc, eq, gt, inArray } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import { appSessions, queueEntries, sandboxes } from "@/lib/db/schema";
import type { SandboxStatus } from "./status";

/** Снимок очереди без обращения к Daytona или изменения состояния машины. */
export async function getSandboxStatus(appSessionId: string): Promise<SandboxStatus> {
  const entries = await getDb().select({
    appSessionId: queueEntries.appSessionId,
    reason: queueEntries.reason,
  }).from(queueEntries)
    .where(gt(queueEntries.heartbeatAt, new Date(Date.now() - 60_000)))
    .orderBy(asc(queueEntries.enqueuedAt), asc(queueEntries.id));
  const position = entries.findIndex((entry) => entry.appSessionId === appSessionId);
  if (position !== -1) {
    return {
      state: "queued",
      queue: { position: position + 1, total: entries.length, reason: entries[position].reason },
    };
  }
  const [sandbox] = await getDb().select({ state: sandboxes.state }).from(sandboxes)
    .where(eq(sandboxes.appSessionId, appSessionId)).limit(1);
  return { state: sandbox === undefined || sandbox.state === "gone" ? "none" : sandbox.state, queue: null };
}

/** Корневая сессия определяется через привязку eve, а не клиентский заголовок. */
export async function removeSandboxQueueEntry(eveSessionId: string, userId?: string): Promise<void> {
  const roots = getDb().select({ id: appSessions.id }).from(appSessions)
    .where(and(
      eq(appSessions.eveSessionId, eveSessionId),
      userId === undefined ? undefined : eq(appSessions.userId, userId),
    ));
  await getDb().delete(queueEntries).where(inArray(queueEntries.appSessionId, roots));
}
