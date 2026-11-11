import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, test } from "vitest";

import { agentSessions, appSessions, queueEntries, sandboxes } from "../../lib/db/schema";
import { removeSandboxQueueEntry } from "../../lib/sandbox/queue-state";
import { fetchApp } from "./support/app";
import { loginAs } from "./support/auth";
import { createDaytonaKey, createUser, db, resetDatabase } from "./support/db";
import { fakeSandbox } from "./support/fake-sandbox";

beforeEach(resetDatabase);

async function session(userId: string, eveSessionId?: string) {
  const [row] = await db().insert(appSessions).values({ userId, eveSessionId }).returning();
  return row;
}

async function enqueue(
  root: { id: string; userId: string },
  overrides: Partial<typeof queueEntries.$inferInsert> = {},
) {
  const [row] = await db().insert(queueEntries).values({
    appSessionId: root.id, userId: root.userId, need: "create", ...overrides,
  }).returning();
  return row;
}

async function status(id: string, cookie?: string) {
  return fetchApp(`/api/sessions/${id}/sandbox`, { headers: cookie ? { cookie } : {} });
}

describe("GET /api/sessions/:id/sandbox", () => {
  test("вход обязателен; чужая, отсутствующая и некорректная сессии — 404", async () => {
    const owner = await createUser();
    const root = await session(owner.id);
    expect((await status(root.id)).status).toBe(401);
    const cookie = await loginAs(await createUser());
    for (const id of [root.id, randomUUID(), "not-a-uuid"]) {
      expect((await status(id, cookie)).status).toBe(404);
    }
  });

  test("нет песочницы и gone → none; остальные состояния доступны без Daytona", async () => {
    const user = await createUser();
    const root = await session(user.id);
    const cookie = await loginAs(user);
    const before = await fakeSandbox.counters();
    expect(await (await status(root.id, cookie)).json()).toEqual({ state: "none", queue: null });
    const key = await createDaytonaKey();
    await db().insert(sandboxes).values({
      appSessionId: root.id, daytonaKeyId: key.id, daytonaSandboxId: "missing-machine", state: "gone",
    });
    for (const state of ["gone", "starting", "started", "stopped", "archived"] as const) {
      await db().update(sandboxes).set({ state }).where(eq(sandboxes.appSessionId, root.id));
      const response = await status(root.id, cookie);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({ state: state === "gone" ? "none" : state, queue: null });
    }
    expect(await fakeSandbox.counters()).toEqual(before);
  });

  test("живая очередь имеет приоритет; порядок enqueuedAt/id, протухшие строки не учитываются", async () => {
    const user = await createUser();
    const first = await session(user.id);
    const second = await session(user.id);
    const stale = await session(user.id);
    const when = new Date(Date.now() - 5_000);
    await enqueue(second, {
      id: "00000000-0000-4000-8000-000000000002", enqueuedAt: when, reason: "own_session_busy",
    });
    await enqueue(first, { id: "00000000-0000-4000-8000-000000000001", enqueuedAt: when });
    await enqueue(stale, { enqueuedAt: new Date(0), heartbeatAt: new Date(Date.now() - 61_000) });
    const cookie = await loginAs(user);
    expect(await (await status(first.id, cookie)).json()).toEqual({
      state: "queued", queue: { position: 1, total: 2, reason: "capacity" },
    });
    expect(await (await status(second.id, cookie)).json()).toEqual({
      state: "queued", queue: { position: 2, total: 2, reason: "own_session_busy" },
    });
    expect(await (await status(stale.id, cookie)).json()).toEqual({ state: "none", queue: null });
  });
});

describe("освобождение очереди по сессии eve", () => {
  test("удаляется только привязанный корень; чужой userId и копия ничего не меняют", async () => {
    const user = await createUser();
    const root = await session(user.id, "root-queue-test");
    const other = await session(user.id, "other-root-queue-test");
    await enqueue(root);
    await enqueue(other);
    await removeSandboxQueueEntry("root-queue-test", randomUUID());
    await removeSandboxQueueEntry("unknown-child");
    expect(await db().select().from(queueEntries)).toHaveLength(2);
    await removeSandboxQueueEntry("root-queue-test", user.id);
    expect(await db().select().from(queueEntries)).toMatchObject([{ appSessionId: other.id }]);
    await removeSandboxQueueEntry("other-root-queue-test");
    expect(await db().select().from(queueEntries)).toHaveLength(0);
  });

  test("POST cancel проверяет владельца до удаления; cancel копии запрещён", async () => {
    const owner = await createUser();
    const root = await session(owner.id, `queue-cancel-${randomUUID()}`);
    await enqueue(root);
    const childId = `queue-child-${randomUUID()}`;
    await db().insert(agentSessions).values({
      appSessionId: root.id, eveSessionId: childId, callId: "queue-call", name: "agent",
    });
    const ownerCookie = await loginAs(owner);
    const strangerCookie = await loginAs(await createUser());
    const cancel = (id: string, cookie: string) => fetchApp(`/eve/v1/session/${id}/cancel`, {
      method: "POST", headers: { cookie },
    });
    expect((await cancel(root.eveSessionId!, strangerCookie)).status).toBe(403);
    expect((await cancel(childId, ownerCookie)).status).toBe(403);
    expect(await db().select().from(queueEntries)).toHaveLength(1);
    const response = await cancel(root.eveSessionId!, ownerCookie);
    expect(response.ok).toBe(true);
    expect(await db().select().from(queueEntries)).toHaveLength(0);
  });
});
