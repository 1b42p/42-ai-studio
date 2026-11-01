/** Сессии приложения и привязка сессий eve: маршруты и окно создания. */
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, test } from "vitest";

import { appSessions } from "../../lib/db/schema";
import { fetchApp } from "./support/app";
import { loginAs } from "./support/auth";
import {
  createSessionAs,
  eveClientAs,
  readStreamUntil,
  waitForStoredEvents,
} from "./support/chat";
import { createUser, db, resetDatabase } from "./support/db";
import { telegramStub } from "./support/telegram";

beforeEach(async () => {
  await telegramStub.reset();
  await resetDatabase();
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe("POST /api/sessions", () => {
  test("без входа — 401", async () => {
    const response = await fetchApp("/api/sessions", { method: "POST" });
    expect(response.status).toBe(401);
  });

  test("со входом — 201 и uuid", async () => {
    const user = await createUser();
    const cookie = await loginAs(user);

    const response = await fetchApp("/api/sessions", {
      method: "POST",
      headers: { cookie },
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as { id: string };
    expect(body.id).toMatch(UUID);

    const [row] = await db().select().from(appSessions).where(eq(appSessions.id, body.id));
    expect(row?.userId).toBe(user.id);
    expect(row?.eveSessionId).toBeNull();
  });

  test("с чужим Origin — 403", async () => {
    const user = await createUser();
    const cookie = await loginAs(user);

    const response = await fetchApp("/api/sessions", {
      method: "POST",
      headers: { cookie, origin: "https://evil.example.com" },
    });

    expect(response.status).toBe(403);
  });
});

describe("GET /api/sessions/:id", () => {
  test("своя сессия отдаёт поля контракта", async () => {
    const user = await createUser();
    const cookie = await loginAs(user);
    const { id } = await createSessionAs(user);

    const response = await fetchApp(`/api/sessions/${id}`, { headers: { cookie } });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      id,
      title: null,
      eveSessionId: null,
      streamCursor: 0,
    });
  });

  test("чужая, несуществующая и не uuid — 404", async () => {
    const owner = await createUser();
    const stranger = await createUser();
    const cookie = await loginAs(stranger);
    const { id } = await createSessionAs(owner);

    for (const path of [
      `/api/sessions/${id}`,
      `/api/sessions/00000000-0000-4000-8000-000000000000`,
      "/api/sessions/not-a-uuid",
    ]) {
      const response = await fetchApp(path, { headers: { cookie } });
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({
        error: { code: "not_found", message: "Сессия не найдена" },
      });
    }
  });
});

describe("привязка сессии eve", () => {
  test("первое сообщение создаёт сессию eve и открывает поток сразу", async () => {
    const user = await createUser();
    const { id } = await createSessionAs(user);
    const client = await eveClientAs(user, id);

    const created = await client.sessions.create({ message: "привет" });
    expect(created.session.state.sessionId).toBeTruthy();

    // Без паузы: поток открывается сразу после ответа на создание.
    const events = await readStreamUntil(created.response, "session.waiting", {
      timeoutMs: 12_000,
    });
    expect(events.map((event) => event.type)).toContain("message.received");
    const completed = events.find((event) => event.type === "message.completed");
    expect(completed?.data).toMatchObject({ message: "Эхо: привет" });

    const stored = await waitForStoredEvents(
      user,
      id,
      (items) => items.some((item) => item.payload.type === "session.waiting"),
    );
    expect(stored[0]?.seq).toBe(0);

    const cookie = await loginAs(user);
    const state = await fetchApp(`/api/sessions/${id}`, { headers: { cookie } });
    const body = (await state.json()) as { eveSessionId: string | null };
    expect(body.eveSessionId).toBe(created.session.state.sessionId);
  });

  test("без заголовка — 403 session_binding_required", async () => {
    const user = await createUser();
    const cookie = await loginAs(user);

    const response = await fetchApp("/eve/v1/session", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ message: "привет" }),
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "session_binding_required" });
  });

  test("с чужой сессией — 403 session_not_found", async () => {
    const owner = await createUser();
    const stranger = await createUser();
    const { id } = await createSessionAs(owner);
    const cookie = await loginAs(stranger);

    const response = await fetchApp("/eve/v1/session", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie,
        "x-studio-session-id": id,
      },
      body: JSON.stringify({ message: "привет" }),
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "session_not_found" });
  });

  test("повторное создание для начатой сессии — 403 session_already_started", async () => {
    const user = await createUser();
    const { id } = await createSessionAs(user);
    const client = await eveClientAs(user, id);

    const created = await client.sessions.create({ message: "привет" });
    await readStreamUntil(created.response, "session.waiting", { timeoutMs: 12_000 });

    const cookie = await loginAs(user);
    const response = await fetchApp("/eve/v1/session", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie,
        "x-studio-session-id": id,
      },
      body: JSON.stringify({ message: "ещё" }),
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "session_already_started" });
  });
});
