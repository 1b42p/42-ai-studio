/** Конкурентные клиенты вызывают публичный lifecycle, база и backend настоящие. */
import { randomUUID } from "node:crypto";
import path from "node:path";
import { eq } from "drizzle-orm";
import type { SandboxSessionContext } from "eve/sandbox/provider";
import { beforeEach, expect, test } from "vitest";

import { createDaytonaLifecycle } from "../../agent/lib/daytona-provider";
import { loadConfig } from "../../lib/config";
import { getFakeBackend } from "../../lib/sandbox/fake";
import { appSessions, daytonaKeys, sandboxes } from "../../lib/db/schema";
import { assertEveSessionAccess } from "../../lib/sessions/access";
import { createDaytonaKey, createUser, db, resetDatabase } from "./support/db";
import { fakeSandbox } from "./support/fake-sandbox";

beforeEach(async () => {
  await resetDatabase();
  await fakeSandbox.reset();
});

test("первое вложение привязывает поток к владельцу до session.started", async () => {
  await createDaytonaKey();
  const user = await createUser();
  const other = await createUser();
  const eveSessionId = randomUUID();
  const [session] = await db().insert(appSessions).values({ userId: user.id, startRequestedAt: new Date() }).returning();
  const principal = {
    authenticator: "studio", principalType: "user" as const, principalId: user.id,
    attributes: { appSessionId: session.id },
  };
  const ctx = {
    kind: "session",
    session: { id: eveSessionId, auth: { current: principal, initiator: principal }, turn: { id: randomUUID(), sequence: 0 } },
    storagePath: loadConfig().fakeSandboxDir!,
    resolveProjectPath: (filename: string) => path.resolve(filename),
  } satisfies SandboxSessionContext;
  const lifecycle = createDaytonaLifecycle();
  const artifact = { templateKey: "first-attachment", dockerfile: "FROM python:3.12-slim-bookworm\n", files: [] };
  // Нет хука session.started: eve ещё раскладывает входящее вложение.
  const opened = await lifecycle.start(ctx, undefined, artifact);
  try {
    const [bound] = await db().select().from(appSessions).where(eq(appSessions.id, session.id));
    expect(bound.eveSessionId).toBe(eveSessionId);
    await expect(assertEveSessionAccess(user, eveSessionId, "stream")).resolves.toBeUndefined();
    await expect(assertEveSessionAccess(other, eveSessionId, "stream")).rejects.toMatchObject({ code: "session_forbidden" });
  } finally {
    await opened.connection.close?.();
    await lifecycle.onSessionEnd(ctx, opened.state, { reason: "deleted" });
  }
});

test("имена машин уникальны внутри организации, но не между организациями", async () => {
  const directory = loadConfig().fakeSandboxDir!;
  const resources = { cpu: 2, memoryGb: 4, diskGb: 8 };
  const a = getFakeBackend(directory, "dtn_names_a", resources);
  const b = getFakeBackend(directory, "dtn_names_b", resources);
  const appSessionId = randomUUID();
  const first = await a.create({ name: "same-name", appSessionId });
  const second = await b.create({ name: "same-name", appSessionId });
  expect(first.id).not.toBe(second.id);
  expect((await a.get("same-name")).id).toBe(first.id);
  expect((await b.get("same-name")).id).toBe(second.id);
  await expect(a.create({ name: "same-name", appSessionId })).rejects.toMatchObject({ status: 409 });
  await Promise.all([first.delete(), second.delete()]);
});

test("два одновременных start одной сессии создают одну песочницу и возвращают её обоим клиентам", async () => {
  const key = await createDaytonaKey();
  const user = await createUser();
  const eveSessionId = randomUUID();
  const [session] = await db().insert(appSessions).values({ userId: user.id, eveSessionId }).returning();
  await fakeSandbox.seed(session.id, { "/workspace/shared.txt": "Одна песочница для обоих клиентов" });
  const ctx = {
    kind: "session",
    session: { id: eveSessionId, auth: { current: null, initiator: null }, turn: { id: randomUUID(), sequence: 0 } },
    storagePath: loadConfig().fakeSandboxDir!,
    resolveProjectPath: (filename: string) => path.resolve(filename),
  } satisfies SandboxSessionContext;
  // Здесь проверяется start, не сборка шаблона (её проверяет отдельный build e2e).
  const artifact = { templateKey: "concurrency-test", dockerfile: "FROM python:3.12-slim-bookworm\nRUN mkdir -p /workspace\n", files: [] };
  const first = createDaytonaLifecycle();
  const second = createDaytonaLifecycle();
  const opened = await Promise.all([first.start(ctx, undefined, artifact), second.start(ctx, undefined, artifact)]);
  try {
    expect(opened[0].state).toEqual(opened[1].state);
    expect((await fakeSandbox.counters()).created).toBe(1);
    const rows = await db().select().from(sandboxes).where(eq(sandboxes.appSessionId, session.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ state: "started", daytonaSandboxId: opened[0].state.sandboxId });
    for (const { connection } of opened) {
      const bytes = await connection.readFile({ path: "/workspace/shared.txt" });
      expect(bytes).not.toBeNull();
      const text = bytes instanceof Uint8Array
        ? new TextDecoder().decode(bytes)
        : await new Response(bytes).text();
      expect(text).toBe("Одна песочница для обоих клиентов");
    }
    await opened[0].connection.stop();
    const resumed = await Promise.all([
      first.resume(ctx, artifact, opened[0].state),
      second.resume(ctx, artifact, opened[1].state),
    ]);
    try {
      expect((await fakeSandbox.counters()).started).toBe(1);
      for (const connection of resumed) {
        expect(await connection.readFile({ path: "/workspace/shared.txt" })).not.toBeNull();
      }
    } finally {
      await Promise.all(resumed.map((connection) => connection.close?.()));
    }
  } finally {
    await Promise.all(opened.map(({ connection }) => connection.close?.()));
    await db().update(daytonaKeys).set({ deletedAt: new Date() }).where(eq(daytonaKeys.id, key.id));
    await first.onSessionEnd(ctx, opened[0].state, { reason: "deleted" });
  }
  expect((await fakeSandbox.counters()).deleted).toBe(1);
  await first.onSessionEnd(ctx, null, { reason: "deleted" });
  expect((await fakeSandbox.counters()).deleted).toBe(1);
});
