import { randomUUID } from "node:crypto";
import path from "node:path";
import { eq } from "drizzle-orm";
import type { SandboxSessionContext } from "eve/sandbox/provider";
import { beforeEach, expect, test, vi } from "vitest";

import { studioAuth } from "../../agent/channels/eve";
import * as backends from "../../agent/lib/daytona-backend";
import { createDaytonaLifecycle } from "../../agent/lib/daytona-provider";
import { loadConfig } from "../../lib/config";
import { appSessions, queueEntries, sandboxes } from "../../lib/db/schema";
import { loginAs } from "./support/auth";
import { createDaytonaKey, createUser, db, resetDatabase } from "./support/db";
import { fakeSandbox } from "./support/fake-sandbox";

beforeEach(async () => {
  await resetDatabase();
  await fakeSandbox.reset();
});

test("cancel до регистрации очереди запрещает позднее пробуждение, но не следующий ход", async () => {
  await createDaytonaKey();
  const user = await createUser();
  const eveSessionId = randomUUID();
  const [session] = await db().insert(appSessions).values({ userId: user.id, eveSessionId }).returning();
  const ctx = {
    kind: "session",
    session: {
      id: eveSessionId,
      auth: { current: null, initiator: null },
      turn: { id: randomUUID(), sequence: 0 },
    },
    storagePath: loadConfig().fakeSandboxDir!,
    resolveProjectPath: (filename: string) => path.resolve(filename),
  } satisfies SandboxSessionContext;
  const lifecycle = createDaytonaLifecycle();
  const artifact = { templateKey: "cancel-race", dockerfile: "FROM python:3.12-slim-bookworm\n", files: [] };
  const opened = await lifecycle.start(ctx, undefined, artifact);
  await opened.connection.stop();
  await opened.connection.close?.();
  const before = await fakeSandbox.counters();

  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const originalBackend = backends.daytonaBackend;
  let delayed = false;
  const spy = vi.spyOn(backends, "daytonaBackend").mockImplementation((...args) => {
    const backend = originalBackend(...args);
    return {
      ...backend,
      async get(idOrName) {
        if (!delayed && idOrName === opened.state.sandboxId) {
          delayed = true;
          entered.resolve();
          await release.promise;
        }
        return backend.get(idOrName);
      },
    };
  });
  const pending = lifecycle.resume(ctx, artifact, opened.state)
    .then((connection) => ({ connection, error: null }), (error: unknown) => ({ connection: null, error }));
  try {
    await entered.promise;
    expect(await db().select().from(queueEntries)).toHaveLength(0);
    const request = new Request(`http://localhost/eve/v1/session/${eveSessionId}/cancel`, {
      method: "POST", headers: { cookie: await loginAs(user) },
    });
    expect(await studioAuth()(request)).toMatchObject({ principalId: user.id });
    release.resolve();
    const outcome = await pending;
    await outcome.connection?.close?.();
    expect(outcome.error).toMatchObject({ code: "sandbox_wait_cancelled" });
    expect(await db().select().from(queueEntries)).toHaveLength(0);
    expect((await fakeSandbox.counters()).started).toBe(before.started);
    const [row] = await db().select().from(sandboxes).where(eq(sandboxes.appSessionId, session.id));
    expect(row.state).not.toBe("started");

    await expect(lifecycle.resume(ctx, artifact, opened.state)).rejects.toMatchObject({ code: "sandbox_wait_cancelled" });
    const next = { ...ctx, session: { ...ctx.session, turn: { id: randomUUID(), sequence: 1 } } };
    const connection = await lifecycle.resume(next, artifact, opened.state);
    await connection.close?.();
    expect((await fakeSandbox.counters()).started).toBe(before.started + 1);
  } finally {
    release.resolve();
    await pending;
    spy.mockRestore();
    await lifecycle.onSessionEnd(ctx, opened.state, { reason: "deleted" });
  }
});
