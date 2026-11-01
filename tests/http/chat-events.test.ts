/** Сохранение событий: непрерывный префикс, курсор, границы after/limit. */
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, test } from "vitest";

import { appSessions } from "../../lib/db/schema";
import { fetchApp } from "./support/app";
import { loginAs } from "./support/auth";
import {
  createSessionAs,
  eveClientAs,
  sendAndWait,
  waitForStoredEvents,
} from "./support/chat";
import { createUser, db, resetDatabase } from "./support/db";
import { telegramStub } from "./support/telegram";

beforeEach(async () => {
  await telegramStub.reset();
  await resetDatabase();
});

async function readEvents(
  user: Awaited<ReturnType<typeof createUser>>,
  appSessionId: string,
  query = "",
): Promise<{ status: number; body: { events: Array<{ seq: number; payload: unknown }>; cursor: number } }> {
  const cookie = await loginAs(user);
  const response = await fetchApp(`/api/sessions/${appSessionId}/events${query}`, {
    headers: { cookie },
  });
  return { status: response.status, body: (await response.json()) as never };
}

describe("GET /api/sessions/:id/events", () => {
  test("после хода хранит непрерывный префикс и совпадает с потоком", async () => {
    const user = await createUser();
    const { id } = await createSessionAs(user);
    await sendAndWait(user, id, "привет");

    const stored = await waitForStoredEvents(
      user,
      id,
      (events) => events.some((event) => event.payload.type === "session.waiting"),
      { timeoutMs: 5000 },
    );

    expect(stored.map((event) => event.seq)).toEqual(stored.map((_, index) => index));
    expect(stored.at(-1)?.payload.type).toBe("session.waiting");

    const cookie = await loginAs(user);
    const state = await fetchApp(`/api/sessions/${id}`, { headers: { cookie } });
    const { eveSessionId, streamCursor } = (await state.json()) as {
      eveSessionId: string;
      streamCursor: number;
    };

    const client = await eveClientAs(user, id);
    const streamed: Array<{ id?: string }> = [];
    for await (const event of client.sessions
      .attach(eveSessionId)
      .stream({ startIndex: 0, follow: false })) {
      streamed.push(event.meta);
    }

    expect(stored.map((event) => (event.payload.meta as { id?: string }).id)).toEqual(
      streamed.map((meta) => meta.id),
    );
    expect(streamCursor).toBe(stored.length);
  });

  test("after и limit работают на границах", async () => {
    const user = await createUser();
    const { id } = await createSessionAs(user);
    await sendAndWait(user, id, "привет");
    const all = await waitForStoredEvents(user, id, (events) =>
      events.some((event) => event.payload.type === "session.waiting"),
    );

    const first = await readEvents(user, id, "?limit=1");
    expect(first.status).toBe(200);
    expect(first.body.events).toHaveLength(1);
    expect(first.body.events[0]?.seq).toBe(0);

    const afterFirst = await readEvents(user, id, "?after=0&limit=1");
    expect(afterFirst.body.events).toHaveLength(1);
    expect(afterFirst.body.events[0]?.seq).toBe(1);

    const tail = await readEvents(user, id, `?after=${all.length - 2}`);
    expect(tail.body.events.map((event) => event.seq)).toEqual([all.length - 1]);
    expect(tail.body.cursor).toBe(all.length);

    const allByDefault = await readEvents(user, id);
    expect(allByDefault.body.events).toHaveLength(all.length);
  });

  test("неверные after и limit — 400 invalid_request", async () => {
    const user = await createUser();
    const { id } = await createSessionAs(user);

    for (const query of ["?limit=0", "?after=abc", "?after=-2", "?limit=5001", "?limit=1.5"]) {
      const response = await readEvents(user, id, query);
      expect(response.status, query).toBe(400);
      expect((response.body as { error?: { code: string } }).error?.code).toBe("invalid_request");
    }
  });

  test("чужая сессия — 404", async () => {
    const owner = await createUser();
    const stranger = await createUser();
    const { id } = await createSessionAs(owner);

    const response = await readEvents(stranger, id);
    expect(response.status).toBe(404);
  });

  test("updated_at сессии меняется при сохранении хода", async () => {
    const user = await createUser();
    const { id } = await createSessionAs(user);

    const [before] = await db().select().from(appSessions).where(eq(appSessions.id, id));
    await sendAndWait(user, id, "привет");
    await waitForStoredEvents(user, id, (events) =>
      events.some((event) => event.payload.type === "session.waiting"),
    );
    const [after] = await db().select().from(appSessions).where(eq(appSessions.id, id));

    expect(after?.updatedAt.getTime()).toBeGreaterThan(before?.updatedAt.getTime() ?? 0);
  });
});
