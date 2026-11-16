import { and, asc, eq, inArray, isNull, ne } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import { appSessions, daytonaKeys, sandboxes, users } from "@/lib/db/schema";
import { sessionIsBusyForAdmin } from "@/lib/sandbox/busy";
import { queuePositions } from "@/lib/sandbox/queue-state";
import type { AdminSandboxesResponse } from "./resource-types";

export async function getAdminSandboxes(): Promise<AdminSandboxesResponse> {
  const db = getDb();
  const now = new Date();
  const [rows, entries, keys] = await Promise.all([
    db.select({
      appSessionId: sandboxes.appSessionId,
      user: { id: users.id, name: users.name, username: users.username },
      keyId: daytonaKeys.id,
      keyLabel: daytonaKeys.label,
      state: sandboxes.state,
      runningSince: sandboxes.runningSince,
      lastActiveAt: sandboxes.lastActiveAt,
    }).from(sandboxes)
      .innerJoin(appSessions, eq(appSessions.id, sandboxes.appSessionId))
      .innerJoin(users, eq(users.id, appSessions.userId))
      .innerJoin(daytonaKeys, eq(daytonaKeys.id, sandboxes.daytonaKeyId))
      .where(and(isNull(appSessions.deletedAt), ne(sandboxes.state, "gone")))
      .orderBy(asc(sandboxes.runningSince), asc(sandboxes.appSessionId)),
    queuePositions(),
    db.select({ id: daytonaKeys.id, label: daytonaKeys.label }).from(daytonaKeys),
  ]);
  const queueUsers = entries.length ? await db.select({
    id: users.id, name: users.name, username: users.username,
  }).from(users).where(inArray(users.id, entries.map((entry) => entry.userId))) : [];
  const userMap = new Map(queueUsers.map((row) => [row.id, row]));
  const keyMap = new Map(keys.map((key) => [key.id, key.label]));
  const counts = { running: 0, stopped: 0, archived: 0, queued: entries.length };
  for (const row of rows) {
    if (row.state === "starting" || row.state === "started") counts.running += 1;
    else if (row.state === "stopped") counts.stopped += 1;
    else if (row.state === "archived") counts.archived += 1;
  }
  const running = await Promise.all(rows.flatMap((row) => {
    if (row.state !== "starting" && row.state !== "started") return [];
    const state = row.state;
    return [sessionIsBusyForAdmin(row.appSessionId, now.getTime()).then((busy) => ({
      ...row,
      state,
      sessionRef: row.appSessionId.slice(0, 8),
      runningSince: row.runningSince?.toISOString() ?? null,
      runningSeconds: row.runningSince === null ? 0 :
        Math.max(0, Math.round((now.getTime() - row.runningSince.getTime()) / 1000)),
      lastActiveAt: row.lastActiveAt.toISOString(),
      busy,
    }))];
  }));
  return {
    generatedAt: now.toISOString(),
    counts,
    running,
    queue: entries.map((entry) => ({
      position: entry.position,
      appSessionId: entry.appSessionId,
      sessionRef: entry.appSessionId.slice(0, 8),
      user: userMap.get(entry.userId)!,
      need: entry.need,
      reason: entry.reason,
      keyLabel: entry.daytonaKeyId === null ? null : keyMap.get(entry.daytonaKeyId) ?? null,
      enqueuedAt: entry.enqueuedAt.toISOString(),
      waitingSeconds: Math.max(0, Math.floor((now.getTime() - entry.enqueuedAt.getTime()) / 1000)),
    })),
  };
}
