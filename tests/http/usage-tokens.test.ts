import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { MessageStreamEvent } from "eve/client";
import type { InstrumentationModelCallCompletedEvent } from "eve/instrumentation";
import { describe, expect, test, vi } from "vitest";

import { appSessions, usageRecords } from "../../lib/db/schema";
import { sleep } from "../../lib/sleep";
import { recordModelUsage } from "../../lib/usage/model";
import { appOutput } from "./support/app";
import {
  createSessionAs,
  eveClientAs,
  readStreamUntil,
  sendAndWait,
  waitForStoredEvents,
} from "./support/chat";
import { createUser, db } from "./support/db";

async function recordsFor(id: string) {
  return db().select().from(usageRecords).where(eq(usageRecords.appSessionId, id));
}

function tokenTotals(events: readonly MessageStreamEvent[]) {
  return events.reduce((total, event) => {
    if (event.type !== "step.completed") return total;
    const usage = event.data.usage;
    if (usage === undefined) return total;
    total.input += Math.max(0, (usage.inputTokens ?? 0) - (usage.cacheReadTokens ?? 0));
    total.output += usage.outputTokens ?? 0;
    return total;
  }, { input: 0, output: 0 });
}

function recordTotals(rows: Awaited<ReturnType<typeof recordsFor>>) {
  return {
    input: rows.filter((row) => row.kind === "model_input_tokens")
      .reduce((sum, row) => sum + row.amount, 0),
    output: rows.filter((row) => row.kind === "model_output_tokens")
      .reduce((sum, row) => sum + row.amount, 0),
  };
}

function completedCall(sessionId: string): InstrumentationModelCallCompletedEvent {
  return {
    type: "model.call.completed",
    finishReason: "stop",
    idempotencyKey: `usage-test:${randomUUID()}`,
    scope: {
      sessionId,
      attemptId: "attempt",
      attemptIndex: 0,
      stepIndex: 0,
      turnId: "turn_0",
    },
    usage: {
      inputTokens: 1000,
      inputTokenDetails: { cacheReadTokens: 400 },
      outputTokens: 80,
    },
  };
}

describe("учёт токенов через lifecycle настоящего приложения", () => {
  test("обычный ответ сохраняет расход владельца, равный step.completed в базе", async () => {
    const user = await createUser();
    const { id } = await createSessionAs(user);
    await sendAndWait(user, id, "привет token-private-31");
    const stored = await waitForStoredEvents(user, id, (events) =>
      events.some(({ payload }) => payload.type === "session.waiting"));
    const rows = await recordsFor(id);
    expect(rows.filter((row) => row.kind === "model_input_tokens")).toHaveLength(1);
    expect(rows.filter((row) => row.kind === "model_output_tokens")).toHaveLength(1);
    expect(rows.every((row) => row.userId === user.id)).toBe(true);
    expect(recordTotals(rows)).toEqual(tokenTotals(stored.map((row) => row.payload)));
    expect(recordTotals(rows).input).toBeGreaterThan(0);
    expect(recordTotals(rows).output).toBeGreaterThan(0);
    expect(JSON.stringify(rows)).not.toContain("token-private-31");
    expect(Object.keys(rows[0]).sort()).toEqual([
      "amount", "appSessionId", "id", "kind", "recordedAt", "sourceKey", "userId",
    ]);
  }, 60_000);

  test("ненулевой кэш вычитается, source_key общий у двух видов расхода", async () => {
    const user = await createUser();
    const { id } = await createSessionAs(user);
    const startedAt = Date.now();
    const events = await sendAndWait(user, id, "/usage 1000 400 80");
    const rows = await recordsFor(id);
    expect(rows).toHaveLength(2);
    expect(recordTotals(rows)).toEqual({ input: 600, output: 80 });
    expect(recordTotals(rows)).toEqual(tokenTotals(events));
    expect(new Set(rows.map((row) => row.sourceKey)).size).toBe(1);
    expect(rows.every((row) => row.recordedAt.getTime() >= startedAt)).toBe(true);
  }, 60_000);

  test("копия добавляет собственные вызовы тому же владельцу без повторного учёта tool usage", async () => {
    const user = await createUser();
    const { id } = await createSessionAs(user);
    const root = await sendAndWait(user, id, '/tool agent {"message":"привет"}');
    const childStarted = root.find((event) => event.type === "agent.started");
    expect(childStarted).toBeDefined();
    const client = await eveClientAs(user, id);
    const child = await readStreamUntil(
      client.sessions.attach(childStarted!.data.sessionId).stream({ follow: false }),
      "session.waiting",
    );
    const rows = await recordsFor(id);
    const rootTotals = tokenTotals(root);
    const childTotals = tokenTotals(child);
    expect(rows.every((row) => row.userId === user.id && row.appSessionId === id)).toBe(true);
    expect(rows.filter((row) => row.kind === "model_input_tokens").length)
      .toBeGreaterThan(root.filter((event) => event.type === "step.completed").length);
    expect(recordTotals(rows)).toEqual({
      input: rootTotals.input + childTotals.input,
      output: rootTotals.output + childTotals.output,
    });
  }, 90_000);

  test("провайдер без usage завершает ход без записей и предупреждений", async () => {
    const user = await createUser();
    const { id } = await createSessionAs(user);
    const logOffset = appOutput().length;
    const events = await sendAndWait(user, id, "/usage none");
    expect(events.find((event) => event.type === "message.completed")?.data.message)
      .toBe("Эхо: /usage none");
    expect(await recordsFor(id)).toEqual([]);
    expect(appOutput().slice(logOffset)).not.toContain("[usage:model]");
  }, 60_000);
});

describe("идемпотентность и привязка расхода", () => {
  test("параллельный повтор одного вызова создаёт ровно две записи", async () => {
    const user = await createUser();
    const { id } = await createSessionAs(user);
    const eveSessionId = `usage-root-${randomUUID()}`;
    await db().update(appSessions).set({ eveSessionId }).where(eq(appSessions.id, id));
    const event = completedCall(eveSessionId);
    await Promise.all([recordModelUsage(event), recordModelUsage(event)]);
    const rows = await recordsFor(id);
    expect(rows).toHaveLength(2);
    expect(recordTotals(rows)).toEqual({ input: 600, output: 80 });
  });

  test("поздняя привязка корня находится при повторном поиске", async () => {
    const user = await createUser();
    const { id } = await createSessionAs(user);
    const eveSessionId = `usage-delayed-${randomUUID()}`;
    await Promise.all([
      recordModelUsage(completedCall(eveSessionId)),
      (async () => {
        await sleep(100);
        await db().update(appSessions).set({ eveSessionId }).where(eq(appSessions.id, id));
      })(),
    ]);
    expect(await recordsFor(id)).toHaveLength(2);
  });

  test("rootSessionId важнее sessionId; удаляемая сессия ещё сохраняет расход", async () => {
    const user = await createUser();
    const root = await createSessionAs(user);
    const other = await createSessionAs(await createUser());
    const rootId = `usage-root-${randomUUID()}`;
    const childId = `usage-child-${randomUUID()}`;
    await db().update(appSessions).set({ eveSessionId: rootId, deletedAt: new Date() })
      .where(eq(appSessions.id, root.id));
    await db().update(appSessions).set({ eveSessionId: childId })
      .where(eq(appSessions.id, other.id));
    const event = completedCall(childId);
    await recordModelUsage({ ...event, scope: { ...event.scope, rootSessionId: rootId } });
    expect(await recordsFor(other.id)).toEqual([]);
    expect((await recordsFor(root.id)).every((row) => row.userId === user.id)).toBe(true);
    expect(await recordsFor(root.id)).toHaveLength(2);
  });

  test("отсутствующий usage не ищет неизвестную сессию и не предупреждает", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await recordModelUsage({ ...completedCall("not-a-session"), usage: {} });
      expect(warning).not.toHaveBeenCalled();
    } finally {
      warning.mockRestore();
    }
  });

  test("непривязанный вызов после повторов пропускается с фиксированным предупреждением", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await recordModelUsage(completedCall(`private-unbound-${randomUUID()}`));
      expect(warning.mock.calls).toEqual([
        ["[usage:model] session_not_found: Сессия расхода не найдена."],
      ]);
    } finally {
      warning.mockRestore();
    }
  });
});
