import { beforeEach, describe, expect, test, vi } from "vitest";
import { eq } from "drizzle-orm";

import { appSessions, bashJobs, sessionEvents } from "../../lib/db/schema";
import { sessionIsBusy, turnIsBusy } from "../../lib/sandbox/busy";
import { emptyReading } from "../../lib/sandbox/job-directory";
import { createUser, db, resetDatabase } from "./support/db";

const NOW = Date.UTC(2026, 10, 10, 12);
const SIX_HOURS = 6 * 60 * 60_000;

function event(type: string, data: Record<string, unknown> = {}, age = 0) {
  return { payload: { type, data }, createdAt: new Date(NOW - age) };
}

describe("turnIsBusy", () => {
  test("нет истории — свободна; свежая неполная история защищена две минуты", () => {
    expect(turnIsBusy([], NOW)).toBe(false);
    expect(turnIsBusy([event("message.appended", {}, 119_999)], NOW)).toBe(true);
    expect(turnIsBusy([event("message.appended", {}, 120_000)], NOW)).toBe(false);
    expect(turnIsBusy([{ payload: null, createdAt: new Date(NOW) }], NOW)).toBe(false);
  });

  test("открытый ход остаётся занят даже без свежих событий", () => {
    expect(turnIsBusy([event("turn.started", { turnId: "a" }, SIX_HOURS)], NOW)).toBe(true);
  });

  test("неполный следующий ход не наследует свободное состояние завершённого", () => {
    const completed = [event("turn.started", { turnId: "a" }), event("turn.completed", { turnId: "a" })];
    expect(turnIsBusy([...completed, event("step.started", { turnId: "b" })], NOW)).toBe(true);
    expect(turnIsBusy([...completed, event("message.appended", { turnId: "b" })], NOW)).toBe(true);
    expect(turnIsBusy([...completed, event("message.appended", { turnId: "b" }, 120_000)], NOW)).toBe(false);
  });

  test.each(["turn.completed", "turn.failed", "turn.cancelled"])(
    "%s освобождает только совпадающий ход немедленно",
    (terminal) => {
      const started = event("turn.started", { turnId: "a" });
      expect(turnIsBusy([started, event(terminal, { turnId: "a" })], NOW)).toBe(false);
      expect(turnIsBusy([started, event(terminal, { turnId: "old" })], NOW)).toBe(true);
      expect(turnIsBusy([
        started, event(terminal, { turnId: "a" }), event("turn.started", { turnId: "b" }),
      ], NOW)).toBe(true);
    },
  );

  test.each(["session.waiting", "session.failed", "session.completed"])(
    "%s освобождает сессию немедленно и без начала хода в истории",
    (terminal) => {
      expect(turnIsBusy([event("turn.started", { turnId: "a" }), event(terminal)], NOW)).toBe(false);
      expect(turnIsBusy([event(terminal)], NOW)).toBe(false);
    },
  );

  test.each(["turn.waiting"])(
    "%s освобождает сессию до ответа или шага того же хода",
    (wait) => {
      const history = [
        event("turn.started", { turnId: "a" }),
        event(wait, { turnId: "a", on: "input" }),
        event("action.result", { turnId: "a" }),
      ];
      expect(turnIsBusy(history, NOW)).toBe(false);
      for (const resume of ["input.resolved", "step.started"]) {
        expect(turnIsBusy([...history, event(resume, { turnId: "old" })], NOW)).toBe(false);
        expect(turnIsBusy([...history, event(resume, { turnId: "a" })], NOW)).toBe(true);
      }
    },
  );

  test("запрос вопроса ещё не означает парковку хода: другие инструменты могут работать", () => {
    for (const type of ["input.requested", "authorization.required"]) {
      expect(turnIsBusy([
        event("turn.started", { turnId: "a" }), event(type, { turnId: "a" }),
      ], NOW)).toBe(true);
    }
  });

  test("ожидание задач занято; старый terminal не освобождает новый ход", () => {
    expect(turnIsBusy([
      event("turn.started", { turnId: "a" }),
      event("turn.waiting", { turnId: "a", on: "tasks" }),
    ], NOW)).toBe(true);
    expect(turnIsBusy([
      event("turn.started", { turnId: "a" }),
      event("turn.completed", { turnId: "a" }),
      event("turn.started", { turnId: "b" }),
      event("turn.cancelled", { turnId: "a" }),
    ], NOW)).toBe(true);
  });

  test("разрешение отменённого вопроса не оживляет завершённый ход", () => {
    expect(turnIsBusy([
      event("turn.started", { turnId: "a" }),
      event("turn.cancelled", { turnId: "a" }),
      event("input.resolved", { turnId: "a" }),
    ], NOW)).toBe(false);
  });
});

describe("sessionIsBusy: база и граница чтения машины", () => {
  beforeEach(resetDatabase);

  async function session() {
    const user = await createUser();
    const [row] = await db().insert(appSessions).values({ userId: user.id }).returning();
    return row.id;
  }

  async function job(appSessionId: string, age = 0, status: "running" | "completed" = "running") {
    await db().insert(bashJobs).values({
      appSessionId, jobId: "1234abcd", status, createdAt: new Date(NOW - age),
    });
  }

  test("читает события по seq, а не по дате; активный ход не требует I/O машины", async () => {
    const id = await session();
    await db().insert(sessionEvents).values([
      { appSessionId: id, seq: 1, ...event("turn.completed", { turnId: "a" }, 5_000) },
      { appSessionId: id, seq: 0, ...event("turn.started", { turnId: "a" }) },
    ]);
    const readJobDirectory = vi.fn(async () => emptyReading());
    expect(await sessionIsBusy(id, { readJobDirectory }, NOW)).toBe(false);
    await db().insert(sessionEvents).values({
      appSessionId: id, seq: 2, ...event("turn.started", { turnId: "b" }),
    });
    expect(await sessionIsBusy(id, { readJobDirectory }, NOW)).toBe(true);
    expect(readJobDirectory).not.toHaveBeenCalled();
  });

  test("сохранённая граница хода освобождает active, даже если запись idle сорвалась", async () => {
    const id = await session();
    await db().update(appSessions).set({ sandboxWorkState: "active", sandboxWorkEventId: "begin" })
      .where(eq(appSessions.id, id));
    const machine = { readJobDirectory: async () => emptyReading() };
    expect(await sessionIsBusy(id, machine, NOW)).toBe(true);
    await db().insert(sessionEvents).values([
      { appSessionId: id, seq: 0, eventId: "begin", ...event("turn.started", { turnId: "a" }) },
      { appSessionId: id, seq: 1, eventId: "end", ...event("turn.completed", { turnId: "a" }) },
    ]);
    expect(await sessionIsBusy(id, machine, NOW)).toBe(false);
    const [released] = await db().select().from(appSessions).where(eq(appSessions.id, id));
    expect(released.sandboxWorkState).toBe("idle");
    await db().update(appSessions).set({ sandboxWorkState: "active", sandboxWorkEventId: "next-begin" })
      .where(eq(appSessions.id, id));
    expect(await sessionIsBusy(id, machine, NOW)).toBe(true);
  });

  test.each([
    { found: true, alive: true, exitCode: null, busy: true },
    { found: true, alive: true, exitCode: 0, busy: false },
    { found: true, alive: false, exitCode: null, busy: false },
    { found: false, alive: false, exitCode: null, busy: false },
  ])("живость и exit: $found/$alive/$exitCode → $busy", async ({ busy, ...reading }) => {
    const id = await session();
    await job(id);
    const readJobDirectory = vi.fn(async () => ({ ...emptyReading(), ...reading }));
    expect(await sessionIsBusy(id, { readJobDirectory }, NOW)).toBe(busy);
    expect(readJobDirectory).toHaveBeenCalledWith("1234abcd");
  });

  test("ошибка чтения не позволяет признать машину свободной", async () => {
    const id = await session();
    await job(id);
    const readJobDirectory = vi.fn(async () => { throw new Error("недоступно"); });
    expect(await sessionIsBusy(id, { readJobDirectory }, NOW)).toBe(true);
  });

  test("дольше шести часов и завершённые задания не читаются; чужие исключены", async () => {
    const id = await session();
    await job(id, SIX_HOURS + 1);
    await job(await session(), 0);
    const readJobDirectory = vi.fn(async () => ({ ...emptyReading(true), alive: true }));
    expect(await sessionIsBusy(id, { readJobDirectory }, NOW)).toBe(false);
    const completedId = await session();
    await job(completedId, 0, "completed");
    expect(await sessionIsBusy(completedId, { readJobDirectory }, NOW)).toBe(false);
    expect(readJobDirectory).not.toHaveBeenCalled();
  });

  test("ровно шесть часов ещё защищает живую команду", async () => {
    const id = await session();
    await job(id, SIX_HOURS);
    expect(await sessionIsBusy(id, {
      readJobDirectory: async () => ({ ...emptyReading(true), alive: true }),
    }, NOW)).toBe(true);
  });
});
