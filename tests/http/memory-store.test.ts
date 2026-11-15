import { randomUUID } from "node:crypto";

import { eq, sql } from "drizzle-orm";
import type { MemoryScopeContext } from "eve/memory";
import { describe, expect, test } from "vitest";

import memory from "@/agent/memory";
import { memoryUserId } from "@/agent/lib/user-memory";
import { memoryRecallSnapshots, userMemory, users } from "@/lib/db/schema";
import { recallMemory, removeMemory, saveMemory } from "@/lib/memory/store";
import { EMPTY_MEMORY_MESSAGE } from "@/lib/memory/text";

import { createUser, db } from "./support/db";

describe("снимки recall", () => {
  test("повтор возвращает прежний текст после вставки и удаления из другой сессии", async () => {
    const user = await createUser({ memoryEnabled: true });
    const saved = await saveMemory(user.id, "Вертикальные ролики");
    expect(saved.saved).toBe(true);
    if (!saved.saved) throw new Error("Запись не создана.");
    const operationId = randomUUID();
    const original = await recallMemory(user.id, operationId);
    expect(original).toContain("Вертикальные ролики");
    await saveMemory(user.id, "Спокойный голос");
    expect(await recallMemory(user.id, operationId)).toBe(original);
    await removeMemory(user.id, saved.id);
    expect(await recallMemory(user.id, operationId)).toBe(original);
    const fresh = await recallMemory(user.id, randomUUID());
    expect(fresh).toContain("Спокойный голос");
    expect(fresh).not.toContain("Вертикальные ролики");
  });

  test("пустой снимок остаётся пустым; одновременные повторы разделяют один ответ", async () => {
    const user = await createUser();
    const operationId = randomUUID();
    expect(await recallMemory(user.id, operationId)).toBeNull();
    await saveMemory(user.id, "Русская озвучка");
    expect(await recallMemory(user.id, operationId)).toBeNull();
    const next = randomUUID();
    const replies = await Promise.all(Array.from({ length: 10 }, () => recallMemory(user.id, next)));
    expect(new Set(replies).size).toBe(1);
    expect(replies[0]).toContain("Русская озвучка");
    expect(await db().select().from(memoryRecallSnapshots)
      .where(eq(memoryRecallSnapshots.operationId, next))).toHaveLength(1);
  });

  test("опустевшая память замещает прежний блок и сохраняет этот ответ для replay", async () => {
    const user = await createUser();
    const operationId = randomUUID();
    expect(await recallMemory(user.id, operationId, true)).toBe(EMPTY_MEMORY_MESSAGE);
    await saveMemory(user.id, "Новая запись");
    expect(await recallMemory(user.id, operationId, false)).toBe(EMPTY_MEMORY_MESSAGE);
  });

  test("новый снимок удаляет записи старше суток, пользователь удаляется каскадом", async () => {
    const user = await createUser();
    const oldId = randomUUID();
    await db().insert(memoryRecallSnapshots).values({
      operationId: oldId,
      userId: user.id,
      content: "Старый снимок",
      createdAt: sql`now() - interval '25 hours'`,
    });
    await recallMemory(user.id, randomUUID());
    expect(await db().select().from(memoryRecallSnapshots)
      .where(eq(memoryRecallSnapshots.operationId, oldId))).toHaveLength(0);
    const other = await createUser();
    const operationId = randomUUID();
    await recallMemory(user.id, operationId);
    await expect(recallMemory(other.id, operationId)).rejects.toThrow(/Область/);
    expect(await db().select().from(userMemory)
      .where(eq(userMemory.userId, other.id))).toHaveLength(0);
    await saveMemory(user.id, "Запись перед удалением пользователя");
    await db().delete(users).where(eq(users.id, user.id));
    expect(await db().select().from(memoryRecallSnapshots)
      .where(eq(memoryRecallSnapshots.userId, user.id))).toHaveLength(0);
    expect(await db().select().from(userMemory)
      .where(eq(userMemory.userId, user.id))).toHaveLength(0);
  });
});

describe("доверенная область памяти", () => {
  test("принимает только кортеж user и UUID", () => {
    const id = randomUUID();
    expect(memoryUserId(["user", id])).toBe(id);
    for (const value of ["user", [], ["user"], ["user", "bad"], ["other", id], ["user", id, id]]) {
      expect(() => memoryUserId(value)).toThrow(/область/);
    }
  });

  test("использует current, затем initiator; не подменяет чужого принципала инициатором", async () => {
    const enabled = await createUser({ memoryEnabled: true });
    const disabled = await createUser();
    const principal = (principalId: string) => ({
      authenticator: "studio", principalType: "user", principalId, attributes: {},
    });
    const context: MemoryScopeContext = {
      abortSignal: new AbortController().signal,
      session: { id: randomUUID(), auth: { current: null, initiator: principal(enabled.id) } },
      channel: {},
    };
    expect(await memory.scope(context)).toEqual(["user", enabled.id]);
    expect(await memory.scope({
      ...context, session: { ...context.session, auth: {
        current: principal(disabled.id), initiator: principal(enabled.id),
      } },
    })).toBeNull();
    expect(await memory.scope({
      ...context, session: { ...context.session, auth: {
        current: { ...principal(enabled.id), authenticator: "studio-eval" },
        initiator: principal(enabled.id),
      } },
    })).toBeNull();
  });
});
