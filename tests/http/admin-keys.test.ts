/**
 * Админка, ключи Daytona: доступ, добавление, список и операции.
 * Daytona — фиктивный слой, Postgres и S3 тестовые.
 */
import { eq } from "drizzle-orm";
import type { MessageStreamEvent } from "eve/client";
import { beforeEach, describe, expect, test } from "vitest";

import { loadConfig } from "../../lib/config";
import { daytonaKeys, sandboxes } from "../../lib/db/schema";
import { appOutput, fetchApp } from "./support/app";
import { loginAs } from "./support/auth";
import { createSessionAs, sendAndWait } from "./support/chat";
import { createUser, db, resetDatabase } from "./support/db";
import { fakeSandbox } from "./support/fake-sandbox";
import { uploadBytes } from "./support/uploads";
import type { User } from "../../lib/db/schema";

const SECRET = "dtn_admin_secret_alpha";
const OTHER = "dtn_admin_secret_bravo";
const READ_FILE = '/tool read_file {"filePath":"/workspace/notes.txt"}';

beforeEach(async () => {
  await resetDatabase();
  await fakeSandbox.reset();
});

async function api(
  path: string,
  options: { user?: User; method?: string; body?: unknown; origin?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (options.user !== undefined) headers.cookie = await loginAs(options.user);
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (options.origin !== undefined) headers.origin = options.origin;
  return fetchApp(path, {
    method: options.method ?? "GET",
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
}

async function jsonOf(response: Response): Promise<Record<string, unknown>> {
  return response.json() as Promise<Record<string, unknown>>;
}

function toolResult(events: readonly MessageStreamEvent[], name = "read_file") {
  const results = events.filter((event) => event.type === "action.result");
  const event = results.find(
    (item) => item.data.result.kind === "tool-result" && item.data.result.toolName === name,
  );
  expect(event, events.map((item) => item.type).join(", ")).toBeDefined();
  return event!.data;
}

function expectRead(events: readonly MessageStreamEvent[], text: string) {
  const result = toolResult(events);
  expect(result.status).toBe("completed");
  expect(result.result).toMatchObject({
    kind: "tool-result",
    output: { content: expect.stringContaining(text) },
  });
}

function walkKeys(value: unknown, found: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) walkKeys(item, found);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, nested] of Object.entries(value)) {
      found.add(key);
      walkKeys(nested, found);
    }
  }
}

describe("доступ", () => {
  test("страница и маршруты закрыты, чужой Origin не меняет данные", async () => {
    const ordinary = await createUser();
    const operator = await createUser({ isOperator: true });

    const anonymous = await fetchApp("/admin/keys");
    expect(anonymous.status).toBe(307);
    expect(anonymous.headers.get("location")).toBe("/login?next=%2Fadmin%2Fkeys");

    const denied = await fetchApp("/admin/keys", { headers: { cookie: await loginAs(ordinary) } });
    expect(denied.status).toBe(404);

    const page = await fetchApp("/admin/keys", { headers: { cookie: await loginAs(operator) } });
    expect(page.status).toBe(200);

    expect((await api("/api/admin/keys")).status).toBe(401);
    expect((await api("/api/admin/keys", { user: ordinary })).status).toBe(403);
    expect((await api("/api/admin/keys", { user: operator })).status).toBe(200);

    for (const call of [
      () => api("/api/admin/keys", { user: operator, method: "POST", body: { label: "A", apiKey: SECRET }, origin: "https://evil.example" }),
      () => api("/api/admin/keys/00000000-0000-4000-8000-000000000001", {
        user: operator,
        method: "PATCH",
        body: { enabled: false },
        origin: "https://evil.example",
      }),
      () => api("/api/admin/keys/00000000-0000-4000-8000-000000000001", {
        user: operator,
        method: "DELETE",
        origin: "https://evil.example",
      }),
    ]) {
      expect((await call()).status).toBe(403);
    }
  });
});

describe("добавление", () => {
  test("корректный ключ шифруется, отклонённый и недоступный не сохраняются", async () => {
    const operator = await createUser({ isOperator: true });
    const created = await api("/api/admin/keys", {
      user: operator,
      method: "POST",
      body: { label: "Основной", apiKey: SECRET },
    });
    expect(created.status).toBe(201);
    const body = await jsonOf(created);
    expect(JSON.stringify(body)).not.toContain(SECRET);
    expect(body.usage).toMatchObject({ source: "daytona" });
    expect(body.fits).toBe(2);
    expect(body.sandboxes).toEqual({ running: 0, stopped: 0, archived: 0 });

    const [row] = await db().select().from(daytonaKeys);
    expect(row?.apiKeyEncrypted.startsWith("v1:")).toBe(true);
    expect(row?.apiKeyEncrypted).not.toBe(SECRET);
    expect(JSON.stringify(body)).not.toContain(row?.apiKeyEncrypted);

    const list = await jsonOf(await api("/api/admin/keys", { user: operator }));
    const page = await fetchApp("/admin/keys", { headers: { cookie: await loginAs(operator) } });
    const html = await page.text();
    const leaked = [SECRET, row?.apiKeyEncrypted ?? ""];
    for (const secret of leaked) {
      expect(JSON.stringify(list)).not.toContain(secret);
      expect(html).not.toContain(secret);
      expect(appOutput()).not.toContain(secret);
    }

    await fakeSandbox.rejectKey(OTHER, "unauthorized");
    const rejected = await api("/api/admin/keys", {
      user: operator,
      method: "POST",
      body: { label: "Чужой", apiKey: OTHER },
    });
    expect(rejected.status).toBe(400);
    expect(await db().select().from(daytonaKeys)).toHaveLength(1);

    const down = "dtn_admin_secret_down_1";
    await fakeSandbox.rejectKey(down, "unavailable");
    const unavailable = await api("/api/admin/keys", {
      user: operator,
      method: "POST",
      body: { label: "Сеть", apiKey: down },
    });
    expect(unavailable.status).toBe(502);
    expect(await db().select().from(daytonaKeys)).toHaveLength(1);
  });

  test("та же организация предупреждает, то же название и кривой ввод отвергаются", async () => {
    const operator = await createUser({ isOperator: true });
    await fakeSandbox.setOrganization(SECRET, "org-shared");
    await fakeSandbox.setOrganization(OTHER, "org-shared");
    expect((await api("/api/admin/keys", {
      user: operator,
      method: "POST",
      body: { label: "Основной", apiKey: SECRET },
    })).status).toBe(201);

    const shared = await api("/api/admin/keys", {
      user: operator,
      method: "POST",
      body: { label: "Запасной", apiKey: OTHER },
    });
    expect(shared.status).toBe(201);
    expect(JSON.stringify(await jsonOf(shared))).toContain("Ключи одной организации Daytona делят одну квоту");

    const clash = await api("/api/admin/keys", {
      user: operator,
      method: "POST",
      body: { label: "основной", apiKey: "dtn_admin_secret_clash" },
    });
    expect(clash.status).toBe(409);

    for (const body of [
      { label: "   ", apiKey: SECRET },
      { label: "я".repeat(61), apiKey: SECRET },
      { label: "Пробел", apiKey: "dtn key with space" },
      { label: "Короткий", apiKey: "short" },
    ]) {
      expect((await api("/api/admin/keys", { user: operator, method: "POST", body })).status).toBe(400);
    }
  });

  test("сбой чтения использования не отменяет добавление", async () => {
    const operator = await createUser({ isOperator: true });
    const secret = "dtn_admin_secret_usage";
    await fakeSandbox.failUsage(secret, "unexpected");
    const created = await api("/api/admin/keys", {
      user: operator,
      method: "POST",
      body: { label: "Слепой", apiKey: secret },
    });
    expect(created.status).toBe(201);
    expect(await jsonOf(created)).toMatchObject({ usage: { error: "unexpected" } });
    expect(await db().select().from(daytonaKeys)).toHaveLength(1);
  });
});

describe("список", () => {
  test("считает свободное место, прячет удалённые и не отдаёт деньги", async () => {
    const operator = await createUser({ isOperator: true });
    const user = await createUser();
    await fakeSandbox.setQuota(SECRET, { cpu: 10, memoryGb: 10, diskGb: 30 });
    await fakeSandbox.setQuota(OTHER, { cpu: 10, memoryGb: 10, diskGb: 30 });
    const first = await jsonOf(await api("/api/admin/keys", {
      user: operator,
      method: "POST",
      body: { label: "Первый", apiKey: SECRET },
    }));
    const second = await jsonOf(await api("/api/admin/keys", {
      user: operator,
      method: "POST",
      body: { label: "Второй", apiKey: OTHER },
    }));

    const session = await createSessionAs(user);
    await fakeSandbox.seed(session.id, { "/workspace/notes.txt": "на первом\n" });
    expectRead(await sendAndWait(user, session.id, READ_FILE), "на первом");
    await db().update(daytonaKeys).set({ usageCheckedAt: new Date(Date.now() - 60_000) });
    expect((await api(`/api/admin/keys/${first.id}/refresh`, { user: operator, method: "POST" })).status).toBe(200);
    expect((await api(`/api/admin/keys/${second.id}/refresh`, { user: operator, method: "POST" })).status).toBe(200);

    const page = await jsonOf(await api("/api/admin/keys", { user: operator }));
    const items = page.items as Array<Record<string, unknown>>;
    expect(items.map((item) => item.fits)).toEqual([1, 2]);
    expect(items.map((item) => item.order)).toEqual([1, 2]);
    expect(items[0]?.sandboxes).toEqual({ running: 1, stopped: 0, archived: 0 });
    expect(page.defaults).toEqual({ cpu: 2, memoryGb: 4, diskGb: 8 });

    const names = new Set<string>();
    walkKeys(page, names);
    expect(names.has("balance")).toBe(false);
    expect(names.has("cost")).toBe(false);
    expect(names.has("price")).toBe(false);

    await fakeSandbox.failUsage(SECRET, "forbidden");
    await db().update(daytonaKeys).set({ usageCheckedAt: new Date(Date.now() - 60_000) }).where(eq(daytonaKeys.id, String(first.id)));
    const refreshed = await jsonOf(await api(`/api/admin/keys/${first.id}/refresh`, { user: operator, method: "POST" }));
    expect(refreshed.usage).toMatchObject({ error: "forbidden", cpu: { used: 2, quota: 10 } });

    expect((await jsonOf(await api("/api/admin/keys", { user: operator }))).items).toHaveLength(2);
    await api(`/api/admin/keys/${second.id}`, { user: operator, method: "DELETE" });
    expect((await jsonOf(await api("/api/admin/keys", { user: operator }))).items).toHaveLength(1);
    const deleted = await jsonOf(await api("/api/admin/keys?deleted=1", { user: operator }));
    expect(deleted.items).toHaveLength(1);
    expect((deleted.items as Array<{ label: string }>)[0]?.label).toBe("Второй");
  }, 90_000);
});

describe("операции", () => {
  test("отключение уводит новые сессии, включение возвращает ключ", async () => {
    const operator = await createUser({ isOperator: true });
    const user = await createUser();
    const first = await jsonOf(await api("/api/admin/keys", {
      user: operator,
      method: "POST",
      body: { label: "A", apiKey: SECRET },
    }));
    const second = await jsonOf(await api("/api/admin/keys", {
      user: operator,
      method: "POST",
      body: { label: "B", apiKey: OTHER },
    }));
    const session = await createSessionAs(user);
    await fakeSandbox.seed(session.id, { "/workspace/notes.txt": "файл A\n" });
    expectRead(await sendAndWait(user, session.id, READ_FILE), "файл A");
    await fakeSandbox.stop(session.id);

    const disabled = await api(`/api/admin/keys/${first.id}`, {
      user: operator,
      method: "PATCH",
      body: { enabled: false },
    });
    expect(disabled.status).toBe(200);
    expect(await jsonOf(disabled)).toMatchObject({ enabled: false });

    const otherUser = await createUser();
    const moved = await createSessionAs(otherUser);
    await fakeSandbox.seed(moved.id, { "/workspace/notes.txt": "файл B\n" });
    expectRead(await sendAndWait(otherUser, moved.id, READ_FILE), "файл B");
    const keyOf = async (id: string) => {
      const [row] = await db().select().from(sandboxes).where(eq(sandboxes.appSessionId, id));
      return row?.daytonaKeyId;
    };
    expect(await keyOf(moved.id)).toBe(second.id);
    expectRead(await sendAndWait(user, session.id, READ_FILE), "файл A");
    expect(await keyOf(session.id)).toBe(first.id);

    const enabled = await api(`/api/admin/keys/${first.id}`, {
      user: operator,
      method: "PATCH",
      body: { enabled: true },
    });
    expect(enabled.status).toBe(200);
    expect((await api(`/api/admin/keys/${first.id}`, {
      user: operator,
      method: "PATCH",
      body: { enabled: true },
    })).status).toBe(200);
    expect((await api(`/api/admin/keys/${first.id}`, {
      user: operator,
      method: "PATCH",
      body: { enabled: "yes" },
    })).status).toBe(400);
  }, 90_000);

  test("обновление обходит кэш один раз в пять секунд", async () => {
    const operator = await createUser({ isOperator: true });
    const created = await jsonOf(await api("/api/admin/keys", {
      user: operator,
      method: "POST",
      body: { label: "Свежий", apiKey: SECRET },
    }));
    await db().update(daytonaKeys).set({ usageCheckedAt: new Date(Date.now() - 60_000) }).where(eq(daytonaKeys.id, String(created.id)));
    const before = await fakeSandbox.usageCalls(SECRET);
    expect((await api(`/api/admin/keys/${created.id}/refresh`, { user: operator, method: "POST" })).status).toBe(200);
    const after = await fakeSandbox.usageCalls(SECRET);
    expect(after).toBeGreaterThan(before);
    expect((await api(`/api/admin/keys/${created.id}/refresh`, { user: operator, method: "POST" })).status).toBe(200);
    expect(await fakeSandbox.usageCalls(SECRET)).toBe(after);
  });

  test("удаление освобождает ключ, сессия и файл остаются доступны", async () => {
    const operator = await createUser({ isOperator: true });
    const user = await createUser();
    const first = await jsonOf(await api("/api/admin/keys", {
      user: operator,
      method: "POST",
      body: { label: "A", apiKey: SECRET },
    }));
    await api("/api/admin/keys", {
      user: operator,
      method: "POST",
      body: { label: "B", apiKey: OTHER },
    });
    const session = await createSessionAs(user);
    await fakeSandbox.seed(session.id, { "/workspace/notes.txt": "исчезнет\n" });
    expectRead(await sendAndWait(user, session.id, READ_FILE), "исчезнет");
    const body = "кадр";
    const ticket = await uploadBytes(
      user,
      { appSessionId: session.id, name: "clip.txt", contentType: "text/plain", sizeBytes: Buffer.byteLength(body) },
      body,
    );

    const removed = await api(`/api/admin/keys/${first.id}`, { user: operator, method: "DELETE" });
    expect(removed.status).toBe(200);
    expect(await jsonOf(removed)).toEqual({ remainingSandboxes: 0 });
    const [row] = await db().select().from(daytonaKeys).where(eq(daytonaKeys.id, String(first.id)));
    expect(row?.apiKeyEncrypted).toBe("deleted");

    const media = await fetchApp(`/api/media/${ticket.id}`, { headers: { cookie: await loginAs(user) } });
    expect(media.status).toBe(302);
    const file = await fetch(media.headers.get("location")!);
    expect(await file.text()).toBe(body);

    const renewed = await sendAndWait(user, session.id, READ_FILE);
    expect(toolResult(renewed).status).toBe("failed");
    const [sandbox] = await db().select().from(sandboxes).where(eq(sandboxes.appSessionId, session.id));
    expect(sandbox?.daytonaKeyId).not.toBe(first.id);

    expect((await api(`/api/admin/keys/${first.id}`, { user: operator, method: "DELETE" })).status).toBe(404);
    expect((await api("/api/admin/keys/not-a-uuid", { user: operator, method: "DELETE" })).status).toBe(404);
    expect((await api("/api/admin/keys/00000000-0000-4000-8000-000000000099", { user: operator, method: "DELETE" })).status).toBe(404);
  }, 90_000);

  test("отказ удаления песочницы оставляет remainingSandboxes", async () => {
    const operator = await createUser({ isOperator: true });
    const user = await createUser();
    const created = await jsonOf(await api("/api/admin/keys", {
      user: operator,
      method: "POST",
      body: { label: "A", apiKey: SECRET },
    }));
    await api("/api/admin/keys", {
      user: operator,
      method: "POST",
      body: { label: "B", apiKey: OTHER },
    });
    const session = await createSessionAs(user);
    await fakeSandbox.seed(session.id, { "/workspace/notes.txt": "живёт\n" });
    expectRead(await sendAndWait(user, session.id, READ_FILE), "живёт");
    await fakeSandbox.failNextDelete("unavailable");

    const removed = await api(`/api/admin/keys/${created.id}`, { user: operator, method: "DELETE" });
    expect(await jsonOf(removed)).toEqual({ remainingSandboxes: 1 });
    const [row] = await db().select().from(daytonaKeys).where(eq(daytonaKeys.id, String(created.id)));
    expect(row?.apiKeyEncrypted).not.toBe("deleted");
  }, 90_000);
});
