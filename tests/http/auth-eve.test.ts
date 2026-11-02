/** Канал eve: публичное здоровье, закрытые маршруты и права оператора. */
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, test } from "vitest";

import { sessionAuthFor } from "../../agent/channels/eve";
import { users, type User } from "../../lib/db/schema";
import { fetchApp } from "./support/app";
import { loginAs } from "./support/auth";
import { createUser, db, resetDatabase } from "./support/db";
import { telegramStub } from "./support/telegram";

beforeEach(async () => {
  await telegramStub.reset();
  await resetDatabase();
});

describe("публичные и закрытые маршруты", () => {
  test("GET /eve/v1/health без cookie отвечает 200", async () => {
    const response = await fetchApp("/eve/v1/health");

    expect(response.status).toBe(200);
  });

  test("без cookie закрытые маршруты отвечают 401", async () => {
    const create = await fetchApp("/eve/v1/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "привет" }),
    });
    expect(create.status).toBe(401);

    const info = await fetchApp("/eve/v1/info");
    expect(info.status).toBe(401);

    const stream = await fetchApp("/eve/v1/session/x/stream");
    expect(stream.status).toBe(401);
  });
});

describe("GET /eve/v1/info", () => {
  test("обычному пользователю закрыт, оператору открыт", async () => {
    const regular = await createUser();
    const regularCookie = await loginAs(regular);
    expect((await fetchApp("/eve/v1/info", { headers: { cookie: regularCookie } })).status).toBe(
      403,
    );

    const operator = await createUser({ isOperator: true });
    const operatorCookie = await loginAs(operator);
    const response = await fetchApp("/eve/v1/info", { headers: { cookie: operatorCookie } });
    expect(response.status).toBe(200);

    // #8: правила вставки файлов видны в инструкциях агента.
    const text = await response.text();
    expect(text).toContain("Файлы в ответе");
    expect(text).toContain("out/final.mp4");
    expect(text).toContain("20 ссылок");
  });
});

describe("заблокированный пользователь", () => {
  test("POST /eve/v1/session отвечает 403 user_blocked", async () => {
    const user = await createUser();
    const cookie = await loginAs(user);
    await db().update(users).set({ isBlocked: true }).where(eq(users.id, user.id));

    const response = await fetchApp("/eve/v1/session", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ message: "привет" }),
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      ok: false,
      code: "user_blocked",
      error: "Доступ закрыт",
    });
  });
});

describe("принципал аутентификатора", () => {
  const user = {
    id: "00000000-0000-4000-8000-000000000000",
    telegramId: 4242,
    name: "Оператор",
    username: null,
    photoUrl: null,
    isOperator: true,
    isBlocked: false,
    createdAt: new Date(),
    lastLoginAt: null,
  } satisfies User;

  test("allowToolStubs появляется только при APP_TEST_MODE=1", () => {
    expect(sessionAuthFor(user, true)).toMatchObject({
      authenticator: "studio",
      principalType: "user",
      principalId: user.id,
      attributes: { telegramId: "4242" },
      allowToolStubs: true,
    });
    expect(sessionAuthFor(user, false).allowToolStubs).toBeUndefined();
    expect(sessionAuthFor(user, false).attributes).toEqual({ telegramId: "4242" });
  });
});
