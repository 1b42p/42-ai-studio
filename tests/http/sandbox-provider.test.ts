/** Конкурентные клиенты вызывают публичный lifecycle, база и backend настоящие. */
import { randomUUID } from "node:crypto";
import path from "node:path";
import { eq } from "drizzle-orm";
import type { SandboxSessionContext } from "eve/sandbox/provider";
import { expect, test } from "vitest";

import { createDaytonaLifecycle } from "../../agent/lib/daytona-provider";
import { loadConfig } from "../../lib/config";
import { appSessions, daytonaKeys, sandboxes } from "../../lib/db/schema";
import { createDaytonaKey, createUser, db } from "./support/db";
import { fakeSandbox } from "./support/fake-sandbox";

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
  } finally {
    await Promise.all(opened.map(({ connection }) => connection.close?.()));
    await db().update(daytonaKeys).set({ deletedAt: new Date() }).where(eq(daytonaKeys.id, key.id));
    await first.onSessionEnd(ctx, opened[0].state, { reason: "deleted" });
  }
  expect((await fakeSandbox.counters()).deleted).toBe(1);
  await first.onSessionEnd(ctx, null, { reason: "deleted" });
  expect((await fakeSandbox.counters()).deleted).toBe(1);
});
