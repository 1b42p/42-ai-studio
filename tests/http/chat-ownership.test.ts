/** Владелец маршрутов eve: чужая сессия закрыта, своя продолжает работать. */
import { beforeEach, describe, expect, test } from "vitest";

import type { User } from "../../lib/db/schema";
import { fetchApp } from "./support/app";
import { loginAs } from "./support/auth";
import { createSessionAs, sendAndWait } from "./support/chat";
import { createUser, resetDatabase } from "./support/db";
import { telegramStub } from "./support/telegram";

beforeEach(async () => {
  await telegramStub.reset();
  await resetDatabase();
});

interface BoundSession {
  readonly user: User;
  readonly appSessionId: string;
  readonly eveSessionId: string;
}

async function createBoundSession(): Promise<BoundSession> {
  const user = await createUser();
  const { id } = await createSessionAs(user);
  const events = await sendAndWait(user, id, "привет");
  expect(events.at(-1)?.type).toBe("session.waiting");

  const cookie = await loginAs(user);
  const state = await fetchApp(`/api/sessions/${id}`, { headers: { cookie } });
  const body = (await state.json()) as { eveSessionId: string | null };
  if (body.eveSessionId === null) throw new Error("сессия eve не привязалась");

  return { user, appSessionId: id, eveSessionId: body.eveSessionId };
}

describe("чужие сессии eve", () => {
  test("второй пользователь получает 403 session_forbidden на все маршруты сессии", async () => {
    const { eveSessionId } = await createBoundSession();
    const stranger = await createUser();
    const cookie = await loginAs(stranger);

    const requests: Array<{ method: string; path: string; body?: string }> = [
      { method: "GET", path: `/eve/v1/session/${eveSessionId}/stream` },
      { method: "POST", path: `/eve/v1/session/${eveSessionId}`, body: '{"message":"чужое"}' },
      { method: "POST", path: `/eve/v1/session/${eveSessionId}/cancel` },
      { method: "POST", path: `/eve/v1/session/${eveSessionId}/clear` },
      { method: "POST", path: `/eve/v1/session/${eveSessionId}/compact` },
      { method: "POST", path: `/eve/v1/session/${eveSessionId}/reset` },
      { method: "POST", path: "/eve/v1/session/wrun_unknown", body: '{"message":"чужое"}' },
      { method: "GET", path: "/eve/v1/session/wrun_unknown/stream" },
    ];

    for (const request of requests) {
      const response = await fetchApp(request.path, {
        method: request.method,
        headers: {
          cookie,
          ...(request.body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(request.body === undefined ? {} : { body: request.body }),
      });
      expect(response.status, `${request.method} ${request.path}`).toBe(403);
      expect(await response.json()).toMatchObject({ ok: false, code: "session_forbidden" });
    }
  });

  test("после отказов сессия владельца работает, ход не отменён", async () => {
    const { user, appSessionId, eveSessionId } = await createBoundSession();
    const stranger = await createUser();
    const cookie = await loginAs(stranger);

    for (const path of [
      `/eve/v1/session/${eveSessionId}/cancel`,
      `/eve/v1/session/${eveSessionId}/reset`,
      `/eve/v1/session/${eveSessionId}`,
    ]) {
      const response = await fetchApp(path, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ message: "чужое" }),
      });
      expect(response.status).toBe(403);
    }

    const events = await sendAndWait(user, appSessionId, "второе");
    const completed = events.filter((event) => event.type === "message.completed").at(-1);
    expect(completed?.data).toMatchObject({ message: "Эхо: второе" });
    expect(events.at(-1)?.type).toBe("session.waiting");
  });
});
