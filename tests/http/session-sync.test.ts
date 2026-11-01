/** Идемпотентность синхронизации событий и очистка NUL в полезной нагрузке. */
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, test } from "vitest";
import type { MessageStreamEvent } from "eve/client";

import { appSessions, sessionEvents } from "../../lib/db/schema";
import { syncAppSession } from "../../lib/sessions/events";
import { createSessionAs } from "./support/chat";
import { createUser, db, resetDatabase } from "./support/db";
import { telegramStub } from "./support/telegram";

beforeEach(async () => {
  await telegramStub.reset();
  await resetDatabase();
});

function makeEvents(count: number, prefix: string): MessageStreamEvent[] {
  return Array.from({ length: count }, (_, index) => ({
    type: index === 0 ? "session.started" : "message.appended",
    data: { text: `${prefix}-${index}` },
    meta: { id: `${prefix}_evt_${index}`, at: new Date().toISOString() },
  })) as unknown as MessageStreamEvent[];
}

function readerOf(events: MessageStreamEvent[]) {
  return (_eveSessionId: string, startIndex: number): AsyncIterable<MessageStreamEvent> =>
    (async function* () {
      for (const event of events.slice(startIndex)) yield event;
    })();
}

async function prepareSession(): Promise<{ appSessionId: string; eveSessionId: string }> {
  const user = await createUser();
  const { id } = await createSessionAs(user);
  const eveSessionId = `wrun_sync_${Date.now()}`;
  await db().update(appSessions).set({ eveSessionId }).where(eq(appSessions.id, id));
  return { appSessionId: id, eveSessionId };
}

async function storedRows(appSessionId: string) {
  return db()
    .select({ seq: sessionEvents.seq, eventId: sessionEvents.eventId, payload: sessionEvents.payload })
    .from(sessionEvents)
    .where(eq(sessionEvents.appSessionId, appSessionId))
    .orderBy(sessionEvents.seq);
}

describe("syncAppSession", () => {
  test("10 параллельных вызовов не дают повторов и дыр, затем добирает новые события", async () => {
    const { appSessionId } = await prepareSession();
    const events = makeEvents(20, "первый");

    const results = await Promise.all(
      Array.from({ length: 10 }, () => syncAppSession(appSessionId, readerOf(events))),
    );
    expect(results.length).toBe(10);

    const first = await storedRows(appSessionId);
    expect(first.map((row) => row.seq)).toEqual(Array.from({ length: 20 }, (_, index) => index));
    expect(new Set(first.map((row) => row.eventId)).size).toBe(20);

    const [session] = await db().select().from(appSessions).where(eq(appSessions.id, appSessionId));
    expect(session?.streamCursor).toBe(20);

    const grown = [...events, ...makeEvents(5, "второй")];
    await Promise.all(
      Array.from({ length: 10 }, () => syncAppSession(appSessionId, readerOf(grown))),
    );

    const second = await storedRows(appSessionId);
    expect(second.map((row) => row.seq)).toEqual(Array.from({ length: 25 }, (_, index) => index));
    const [after] = await db().select().from(appSessions).where(eq(appSessions.id, appSessionId));
    expect(after?.streamCursor).toBe(25);
  });

  test("символ NUL вычищается, остальные символы строки сохранены", async () => {
    const { appSessionId } = await prepareSession();
    const events = [
      {
        type: "message.completed",
        data: { message: "до\u0000после" },
        meta: { id: "nul_evt_0", at: new Date().toISOString() },
      },
    ] as unknown as MessageStreamEvent[];

    await syncAppSession(appSessionId, readerOf(events));

    const [row] = await storedRows(appSessionId);
    expect((row?.payload as { data: { message: string } }).data.message).toBe("допосле");
  });

  // Название считается из той же очищенной нагрузки: сырое событие в UPDATE
  // с NUL откатывало бы транзакцию, и сессия не сохранялась бы больше никогда.
  test("NUL в первом сообщении не откатывает синхронизацию и не попадает в название", async () => {
    const { appSessionId } = await prepareSession();
    const events = [
      {
        type: "message.received",
        data: { message: "до\u0000после" },
        meta: { id: "nul_received_evt_0", at: new Date().toISOString() },
      },
    ] as unknown as MessageStreamEvent[];

    const result = await syncAppSession(appSessionId, readerOf(events));

    expect(result).toEqual({ stored: 1, cursor: 1 });
    const [row] = await storedRows(appSessionId);
    expect((row?.payload as { data: { message: string } }).data.message).toBe("допосле");
    const [session] = await db().select().from(appSessions).where(eq(appSessions.id, appSessionId));
    expect(session?.title).toBe("Допосле");
    expect(session?.titleSearch).toBe("допосле");
    expect(session?.streamCursor).toBe(1);
  });
});
