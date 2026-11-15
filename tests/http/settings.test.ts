import { describe, expect, test } from "vitest";

import type { User } from "../../lib/db/schema";
import { fetchApp } from "./support/app";
import { loginAs } from "./support/auth";
import { createUser } from "./support/db";

async function settingsAs(user: User): Promise<Response> {
  return fetchApp("/api/settings", { headers: { cookie: await loginAs(user) } });
}

async function patchAs(user: User, body: unknown, extraHeaders: Record<string, string> = {}) {
  return fetchApp("/api/settings", {
    method: "PATCH",
    headers: {
      cookie: await loginAs(user),
      "Content-Type": "application/json",
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
}

describe("настройки пользователя", () => {
  test("новый пользователь получает пустые указания, сохраняет и очищает их", async () => {
    const user = await createUser();
    const initial = await settingsAs(user);
    expect(initial.status).toBe(200);
    expect(initial.headers.get("cache-control")).toBe("no-store");
    expect(await initial.json()).toEqual({ customInstructions: "" });

    const saved = await patchAs(user, { customInstructions: "  Пиши\r\nкратко.\u0000 " });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({ customInstructions: "Пиши\nкратко." });
    expect(await (await settingsAs(user)).json()).toEqual({ customInstructions: "Пиши\nкратко." });

    expect(await (await patchAs(user, { customInstructions: "" })).json())
      .toEqual({ customInstructions: "" });
  });

  test("без входа и заблокированному доступ закрыт", async () => {
    for (const method of ["GET", "PATCH"]) {
      expect((await fetchApp("/api/settings", { method })).status).toBe(401);
    }
    const blocked = await createUser({ isBlocked: true });
    expect((await settingsAs(blocked)).status).toBe(403);
    expect((await patchAs(blocked, { customInstructions: "текст" })).status).toBe(403);
  });

  test("не принимает чужой Origin и не раскрывает настройки другому пользователю", async () => {
    const userA = await createUser();
    const userB = await createUser();
    expect((await patchAs(userA, { customInstructions: "Частные пожелания А" })).status).toBe(200);
    expect(await (await settingsAs(userB)).json()).toEqual({ customInstructions: "" });
    expect((await patchAs(userA, { customInstructions: "чужое" }, {
      origin: "https://evil.example",
    })).status).toBe(403);
    expect(await (await settingsAs(userA)).json())
      .toEqual({ customInstructions: "Частные пожелания А" });
  });

  test("4000 кодовых точек принимаются, 4001 отклоняется без изменения настроек", async () => {
    const user = await createUser();
    const text = "😀".repeat(4000);
    expect((await patchAs(user, { customInstructions: text })).status).toBe(200);
    const tooLong = await patchAs(user, { customInstructions: `${text}😀` });
    expect(tooLong.status).toBe(400);
    expect(await tooLong.json()).toEqual({
      error: {
        code: "invalid_request",
        message: "Общие указания не должны быть длиннее 4000 символов (сейчас 4001).",
      },
    });
    expect(await (await settingsAs(user)).json()).toEqual({ customInstructions: text });
  });

  test.each([
    {}, [], null, 7, { typo: "" }, { customInstructions: 9 },
    { customInstructions: "верное поле", typo: "" },
  ])(
    "неверное тело %j возвращает invalid_request",
    async (body) => {
      const response = await patchAs(await createUser(), body);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "invalid_request" } });
    },
  );

  test("неверный JSON возвращает 400, тело больше 64 КиБ — 413", async () => {
    const cookie = await loginAs(await createUser());
    const invalid = await fetchApp("/api/settings", {
      method: "PATCH", headers: { cookie }, body: "{",
    });
    expect(invalid.status).toBe(400);
    const oversized = await fetchApp("/api/settings", {
      method: "PATCH",
      headers: { cookie },
      body: JSON.stringify({ customInstructions: " ".repeat(70 * 1024) }),
    });
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toMatchObject({ error: { code: "too_large" } });
  });

  test("ограничивает фактические байты потока без Content-Length", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"customInstructions":"'));
        controller.enqueue(new Uint8Array(70 * 1024).fill(32));
        controller.enqueue(new TextEncoder().encode('"}'));
        controller.close();
      },
    });
    const init: RequestInit & { duplex: "half" } = {
      method: "PATCH",
      headers: { cookie: await loginAs(await createUser()) },
      body,
      duplex: "half",
    };
    const response = await fetchApp("/api/settings", init);
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: { code: "too_large" } });
  });

  test("страница без входа перенаправляет на вход с возвратом в настройки", async () => {
    const response = await fetchApp("/settings");
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("/login?next=%2Fsettings");
  });

  test("страница отдаёт сохранённый текст сразу в серверном HTML", async () => {
    const user = await createUser();
    await patchAs(user, { customInstructions: "Сохранённые указания без вспышки." });
    const response = await fetchApp("/settings", { headers: { cookie: await loginAs(user) } });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toMatch(/<textarea[^>]*>Сохранённые указания без вспышки\.<\/textarea>/);
    expect(html).toContain('href="/settings"');
  });
});
