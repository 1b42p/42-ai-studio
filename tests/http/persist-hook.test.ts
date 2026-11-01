/**
 * Поведение хука сохранения: приращения не тормозят поток, границы ждут,
 * `turn.started` отменяет непривязанную сессию, `session.started` привязывает.
 */
import { describe, expect, test } from "vitest";
import type { HookContext, HookEvent } from "eve/hooks";

import {
  createPersistEventHandler,
  type PersistDependencies,
} from "../../agent/lib/persist-hook";
import { sleep } from "../../lib/sleep";

function context(options: {
  appSessionId?: string;
  principalId?: string;
  parent?: { callId: string; rootSessionId: string; sessionId: string };
} = {}): HookContext {
  const initiator =
    options.appSessionId === undefined
      ? null
      : {
          authenticator: "studio",
          principalType: "user",
          principalId: options.principalId ?? "user-1",
          attributes: { appSessionId: options.appSessionId },
        };

  return {
    session: {
      id: "wrun_1",
      auth: { current: initiator, initiator },
      turn: { id: "turn_0", sequence: 0 },
      ...(options.parent === undefined ? {} : { parent: options.parent }),
    },
    agent: { name: "42-ai-studio" },
    channel: { kind: "http" },
    cancel: () => {
      cancelled = true;
    },
    getSandbox: async () => {
      throw new Error("песочницы нет");
    },
  } as unknown as HookContext;
}

let cancelled = false;

function event(type: string, id = `evt_${type}`): HookEvent {
  return {
    type,
    data: {},
    meta: { id, at: new Date().toISOString() },
  } as unknown as HookEvent;
}

function dependencies(overrides: Partial<PersistDependencies> = {}): PersistDependencies {
  return {
    findSessionByEveId: async () => ({ id: "app-1", userId: "user-1" }),
    bindSession: async () => true,
    requestSync: async () => ({ stored: 1, cursor: 1 }),
    syncAndConfirm: async () => true,
    ...overrides,
  };
}

describe("createPersistEventHandler", () => {
  test("приращение возвращает управление быстрее 50 мс, даже если синхронизация идёт 1 с", async () => {
    cancelled = false;
    let pending: Promise<unknown> | undefined;
    const handler = createPersistEventHandler(
      dependencies({
        requestSync: () => {
          pending = sleep(1000);
          return pending;
        },
      }),
    );

    const started = performance.now();
    await handler(event("message.appended"), context());
    const elapsed = performance.now() - started;

    expect(elapsed).toBeLessThan(50);
    await pending;
  });

  test("граница дожидается синхронизации", async () => {
    let confirmed = 0;
    const handler = createPersistEventHandler(
      dependencies({
        syncAndConfirm: async () => {
          await sleep(1000);
          confirmed += 1;
          return true;
        },
      }),
    );

    const started = performance.now();
    await handler(event("turn.completed"), context());
    const elapsed = performance.now() - started;

    expect(elapsed).toBeGreaterThanOrEqual(900);
    expect(confirmed).toBe(1);
  });

  test("session.started привязывает сессию и ждёт сохранения события", async () => {
    cancelled = false;
    const bound: unknown[] = [];
    let confirmedWith: string | null = null;
    let stored = false;
    const handler = createPersistEventHandler(
      dependencies({
        findSessionByEveId: async () => (stored ? { id: "app-42", userId: "user-1" } : null),
        bindSession: async (input) => {
          bound.push(input);
          stored = true;
          return true;
        },
        syncAndConfirm: async (_appSessionId, eventId) => {
          confirmedWith = eventId;
          return true;
        },
      }),
    );

    await handler(event("session.started", "evt_started"), context({ appSessionId: "app-42" }));

    expect(bound).toEqual([
      { appSessionId: "app-42", userId: "user-1", eveSessionId: "wrun_1" },
    ]);
    expect(confirmedWith).toBe("evt_started");
  });

  test("turn.started привязывает сессию, если session.started ещё не успел", async () => {
    cancelled = false;
    const bound: unknown[] = [];
    let stored = false;
    const handler = createPersistEventHandler(
      dependencies({
        findSessionByEveId: async () => (stored ? { id: "app-42", userId: "user-1" } : null),
        bindSession: async (input) => {
          bound.push(input);
          stored = true;
          return true;
        },
      }),
    );

    await handler(event("turn.started"), context({ appSessionId: "app-42" }));

    expect(cancelled).toBe(false);
    expect(bound).toEqual([
      { appSessionId: "app-42", userId: "user-1", eveSessionId: "wrun_1" },
    ]);
  });

  test("turn.started отменяет ход непривязанной сессии", async () => {
    cancelled = false;
    const handler = createPersistEventHandler(
      dependencies({ findSessionByEveId: async () => null }),
    );

    await handler(event("turn.started"), context());

    expect(cancelled).toBe(true);
  });

  test("turn.started отменяет ход, если сессия привязана к чужому пользователю", async () => {
    cancelled = false;
    const handler = createPersistEventHandler(
      dependencies({
        findSessionByEveId: async () => ({ id: "app-1", userId: "user-2" }),
      }),
    );

    await handler(event("turn.started"), context({ appSessionId: "app-1" }));

    expect(cancelled).toBe(true);
  });

  test("дочерние сессии пропускаются", async () => {
    cancelled = false;
    let called = false;
    const handler = createPersistEventHandler(
      dependencies({
        findSessionByEveId: async () => {
          called = true;
          return null;
        },
      }),
    );

    await handler(
      event("turn.started"),
      context({
        parent: { callId: "call_1", rootSessionId: "wrun_root", sessionId: "wrun_parent" },
      }),
    );

    expect(cancelled).toBe(false);
    expect(called).toBe(false);
  });
});
