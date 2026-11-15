import { and, asc, eq, lt, sql } from "drizzle-orm";

import { getDb } from "../db/client";
import { memoryRecallSnapshots, userMemory } from "../db/schema";
import {
  buildMemoryMessage,
  EMPTY_MEMORY_MESSAGE,
  MEMORY_ENTRIES_LIMIT,
  normalizeMemoryText,
  type MemoryEntry,
} from "./text";

export type SaveMemoryResult =
  | { saved: true; id: number }
  | { saved: false; reason: "duplicate" }
  | { saved: false; reason: "limit"; oldest: MemoryEntry[] };

export async function saveMemory(userId: string, input: string): Promise<SaveMemoryResult> {
  const text = normalizeMemoryText(input);
  return getDb().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(3, hashtext(${userId}::text))`);
    const entries = await tx.select({ id: userMemory.id, text: userMemory.text })
      .from(userMemory).where(eq(userMemory.userId, userId)).orderBy(asc(userMemory.id));
    if (entries.some((entry) => entry.text === text)) return { saved: false, reason: "duplicate" };
    if (entries.length >= MEMORY_ENTRIES_LIMIT) {
      return { saved: false, reason: "limit", oldest: entries.slice(0, 5) };
    }
    const [inserted] = await tx.insert(userMemory).values({ userId, text })
      .returning({ id: userMemory.id });
    return { saved: true, id: inserted.id };
  });
}

export async function removeMemory(userId: string, id: number): Promise<{ removed: boolean }> {
  const deleted = await getDb().delete(userMemory)
    .where(and(eq(userMemory.userId, userId), eq(userMemory.id, id)))
    .returning({ id: userMemory.id });
  return { removed: deleted.length !== 0 };
}

/** Сохраняем уже собранный ответ: replay не зависит от последующих правок памяти. */
export async function recallMemory(
  userId: string,
  operationId: string,
  replaceEmpty = false,
): Promise<string | null> {
  return getDb().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(3, hashtext(${userId}::text))`);
    const [snapshot] = await tx.select().from(memoryRecallSnapshots)
      .where(eq(memoryRecallSnapshots.operationId, operationId)).limit(1);
    if (snapshot !== undefined) {
      if (snapshot.userId !== userId) throw new Error("Область снимка памяти не совпадает.");
      return snapshot.content;
    }
    const entries = await tx.select({ id: userMemory.id, text: userMemory.text })
      .from(userMemory).where(eq(userMemory.userId, userId)).orderBy(asc(userMemory.id));
    const content = buildMemoryMessage(entries) ?? (replaceEmpty ? EMPTY_MEMORY_MESSAGE : null);
    await tx.delete(memoryRecallSnapshots)
      .where(lt(memoryRecallSnapshots.createdAt, sql`now() - interval '1 day'`));
    await tx.insert(memoryRecallSnapshots).values({ operationId, userId, content });
    return content;
  });
}
