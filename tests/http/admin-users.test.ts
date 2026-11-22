/**
 * Админка, пользователи: доступ, выдача права, список, блокировка и удаление
 * со всеми данными. Приложение запущено глобальной подготовкой; Daytona,
 * S3 и Postgres настоящие для тестовой обвязки.
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, inject, test } from "vitest";

import { daytonaSandboxName } from "../../agent/lib/daytona-backend";
import { deleteUserData } from "../../lib/admin/delete";
import { loadConfig } from "../../lib/config";
import { getSqlClient } from "../../lib/db/client";
import {
  agentSessions,
  appSessions,
  authSessions,
  bashJobs,
  media,
  memoryRecallSnapshots,
  messageFiles,
  queueEntries,
  sandboxes,
  sessionEvents,
  sessionPreviewCalls,
  toolCallMedia,
  userMemory,
  users,
  type User,
} from "../../lib/db/schema";
import { getFakeBackend } from "../../lib/sandbox/fake";
import { appOutput, fetchApp } from "./support/app";
import { loginAs, loginViaTelegram } from "./support/auth";
import { createSessionAs, sendAndWait, waitForStoredEvents } from "./support/chat";
import { createDaytonaKey, createUser, db, resetDatabase } from "./support/db";
import { fakeSandbox } from "./support/fake-sandbox";
import { DEFAULT_PROFILE } from "./support/oidc-issuer";
import { s3 } from "./support/s3";
import { telegramStub } from "./support/telegram";

beforeEach(async () => {
  await telegramStub.reset();
  await resetDatabase();
  await fakeSandbox.reset();
  await s3().deletePrefix("");
});

async function adminCookie(user: User): Promise<string> {
  return loginAs(user);
}

async function api(
  path: string,
  options: { user?: User; method?: string; body?: unknown; origin?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (options.user !== undefined) headers.cookie = await adminCookie(options.user);
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (options.origin !== undefined) headers.origin = options.origin;
  return fetchApp(path, {
    method: options.method ?? "GET",
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
}

function patch(id: string, user: User, blocked: unknown): Promise<Response> {
  return api(`/api/admin/users/${id}`, { user, method: "PATCH", body: { blocked } });
}

function remove(id: string, user: User, origin?: string): Promise<Response> {
  return api(`/api/admin/users/${id}`, { user, method: "DELETE", origin });
}

describe("доступ", () => {
  test("страницы: нет входа — на /login с возвратом, обычный — 404, оператор — 200", async () => {
    const ordinary = await createUser();
    const operator = await createUser({ isOperator: true });
    const blockedOperator = await createUser({ isOperator: true, isBlocked: true });

    for (const path of ["/admin", "/admin/users"]) {
      const anonymous = await fetchApp(path);
      expect(anonymous.status, path).toBe(307);
      expect(anonymous.headers.get("location"), path).toBe(
        `/login?next=${encodeURIComponent(path)}`,
      );

      const denied = await fetchApp(path, { headers: { cookie: await loginAs(ordinary) } });
      expect(denied.status, path).toBe(404);

      const blocked = await fetchApp(path, {
        headers: { cookie: await loginAs(blockedOperator) },
      });
      expect(blocked.status, path).toBe(307);
      expect(blocked.headers.get("location"), path).toBe("/login?error=blocked");
    }

    const root = await fetchApp("/admin", {
      headers: { cookie: await loginAs(operator) },
    });
    expect(root.status).toBe(307);
    expect(root.headers.get("location")).toBe("/admin/users");

    const page = await fetchApp("/admin/users", {
      headers: { cookie: await loginAs(operator) },
    });
    expect(page.status).toBe(200);
  });

  test("маршруты: 401 без входа, 403 обычному и заблокированному оператору", async () => {
    const ordinary = await createUser();
    const operator = await createUser({ isOperator: true });
    const blockedOperator = await createUser({ isOperator: true, isBlocked: true });
    const target = await createUser();

    expect((await api("/api/admin/users")).status).toBe(401);
    for (const call of [
      () => api("/api/admin/users", { user: ordinary }),
      () => patch(target.id, ordinary, true),
      () => remove(target.id, ordinary),
    ]) {
      expect((await call()).status).toBe(403);
    }

    for (const call of [
      () => api("/api/admin/users", { user: blockedOperator }),
      () => patch(target.id, blockedOperator, true),
      () => remove(target.id, blockedOperator),
    ]) {
      const response = await call();
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        error: { code: "forbidden", message: "Доступ закрыт" },
      });
    }

    expect((await api("/api/admin/users", { user: operator })).status).toBe(200);
    expect((await patch(target.id, operator, true)).status).toBe(200);
    expect((await remove(target.id, operator)).status).toBe(204);
  });

  test("снятие флага лишает доступа на следующем запросе с той же cookie", async () => {
    const operator = await createUser({ isOperator: true });
    const cookie = await loginAs(operator);

    expect((await fetchApp("/admin/users", { headers: { cookie } })).status).toBe(200);
    expect((await fetchApp("/api/admin/users", { headers: { cookie } })).status).toBe(200);

    await getSqlClient()`update users set is_operator = false where id = ${operator.id}`;

    expect((await fetchApp("/admin/users", { headers: { cookie } })).status).toBe(404);
    expect((await fetchApp("/api/admin/users", { headers: { cookie } })).status).toBe(403);

    await getSqlClient()`update users set is_operator = true where id = ${operator.id}`;

    expect((await fetchApp("/admin/users", { headers: { cookie } })).status).toBe(200);
    expect((await fetchApp("/api/admin/users", { headers: { cookie } })).status).toBe(200);
  });

  test("страница ?userId= показывает одного пользователя и чип фильтра", async () => {
    const operator = await createUser({ isOperator: true });
    const target = await createUser({ name: "Отфильтрованный человек" });
    await createUser({ name: "Другой человек" });

    const page = await fetchApp(`/admin/users?userId=${target.id}`, {
      headers: { cookie: await loginAs(operator) },
    });
    expect(page.status).toBe(200);
    const body = await page.text();
    expect(body).toContain("Отфильтрованный человек");
    expect(body).toContain("Фильтр: пользователь");
    expect(body).toContain("Сбросить");

    const invalid = await fetchApp("/admin/users?userId=not-a-uuid", {
      headers: { cookie: await loginAs(operator) },
    });
    expect(invalid.status).toBe(404);
  });

  test("чужой Origin не меняет данные", async () => {
    const operator = await createUser({ isOperator: true });
    const target = await createUser();

    const deniedPatch = await api(`/api/admin/users/${target.id}`, {
      user: operator,
      method: "PATCH",
      body: { blocked: true },
      origin: "https://evil.example",
    });
    expect(deniedPatch.status).toBe(403);
    const [before] = await db().select().from(users).where(eq(users.id, target.id));
    expect(before.isBlocked).toBe(false);
    expect(before.deletionRequestedAt).toBeNull();

    const blocked = await patch(target.id, operator, true);
    expect(blocked.status).toBe(200);
    const [blockedRow] = await db().select().from(users).where(eq(users.id, target.id));
    expect(blockedRow.isBlocked).toBe(true);

    expect((await remove(target.id, operator, "https://evil.example")).status).toBe(403);
    expect(await db().select().from(users).where(eq(users.id, target.id))).toHaveLength(1);
    expect(blockedRow.deletionRequestedAt).toBeNull();
  });
});

describe("выдача права", () => {
  test("строка из INSERT сохраняет флаг и обновляет имя после входа", async () => {
    const telegramId = Number(DEFAULT_PROFILE.id);
    await getSqlClient().unsafe(
      `INSERT INTO users (telegram_id, name, is_operator) VALUES (${telegramId}, 'Оператор', true)
       ON CONFLICT (telegram_id) DO UPDATE SET is_operator = true`,
    );

    const result = await loginViaTelegram();

    expect(result.cookie).not.toBeNull();
    expect(result.user?.isOperator).toBe(true);
    expect(result.user?.name).toBe(DEFAULT_PROFILE.name);
    expect(result.user?.photoUrl).toBe(DEFAULT_PROFILE.picture);
  });

  test("команды из README выполняются на тестовой базе", async () => {
    await createUser({ telegramId: 123456789, name: "Иван", username: "ivan" });
    const sql = getSqlClient();

    await sql.unsafe(
      `SELECT telegram_id, name, username, is_operator FROM users WHERE lower(username) = 'ivan' ORDER BY created_at DESC LIMIT 5`,
    );
    await sql.unsafe(`UPDATE users SET is_operator = true WHERE telegram_id = 123456789`);
    await sql.unsafe(
      `INSERT INTO users (telegram_id, name, is_operator) VALUES (123456790, 'Оператор', true)
       ON CONFLICT (telegram_id) DO UPDATE SET is_operator = true`,
    );
    await sql.unsafe(`UPDATE users SET is_operator = false WHERE telegram_id = 123456789`);
  });
});

async function seedUsers(count: number, start = 0): Promise<User[]> {
  const base = Date.parse("2026-01-01T00:00:00Z");
  const rows = Array.from({ length: count }, (_, index) => {
    const serial = start + index;
    return {
      telegramId: 700000 + serial,
      name: `Пользователь ${serial}`,
      username: serial % 2 === 0 ? `user_${serial}` : null,
      createdAt: new Date(base + serial * 1000),
      lastLoginAt: new Date(base + serial * 1000 + 500),
    };
  });
  return db().insert(users).values(rows).returning();
}

async function listPage(
  operator: User,
  params: Record<string, string> = {},
): Promise<{ status: number; body: any; text: string }> {
  const query = new URLSearchParams(params).toString();
  const response = await api(
    query === "" ? "/api/admin/users" : `/api/admin/users?${query}`,
    { user: operator },
  );
  const text = await response.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  return { status: response.status, body, text };
}

describe("список", () => {
  test("limit=10 отдаёт четыре страницы по порядку, каждый id один раз", async () => {
    const operator = await createUser({ isOperator: true });
    const seeded = await seedUsers(34);
    const expected = [
      operator.telegramId.toString(),
      ...seeded
        .map((user) => user.telegramId.toString())
        .sort((left, right) => Number(right) - Number(left)),
    ];

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 4; page += 1) {
      const result = await listPage(operator, {
        limit: "10",
        ...(cursor === null ? {} : { cursor }),
      });
      expect(result.status, `страница ${page + 1}`).toBe(200);
      expect(result.body.items).toHaveLength(page === 3 ? 5 : 10);
      seen.push(...result.body.items.map((item: { telegramId: string }) => item.telegramId));
      cursor = result.body.nextCursor;
      expect(cursor === null, `nextCursor страницы ${page + 1}`).toBe(page === 3);
    }

    expect(seen).toEqual(expected);
    expect(new Set(seen).size).toBe(35);
  });

  test("поиск по @username, регистру и началу Telegram ID", async () => {
    const operator = await createUser({ isOperator: true });
    await seedUsers(4);
    const ivan = await createUser({
      telegramId: 123456789,
      name: "Иван",
      username: "Ivan_Petrov",
    });

    const at = await listPage(operator, { q: "@Ivan" });
    expect(at.body.items.map((item: { id: string }) => item.id)).toEqual([ivan.id]);
    const lower = await listPage(operator, { q: "ivan" });
    expect(lower.body.items.map((item: { id: string }) => item.id)).toEqual([ivan.id]);
    const prefix = await listPage(operator, { q: "1234" });
    expect(prefix.body.items.map((item: { id: string }) => item.id)).toEqual([ivan.id]);
    const cyrillic = await listPage(operator, { q: "иван" });
    expect(cyrillic.body.items).toEqual([]);

    const underscore = await listPage(operator, { q: "_" });
    expect(underscore.body.items.length).toBeGreaterThan(0);
    expect(underscore.body.items.length).toBeLessThan(underscore.body.totals.users);
    for (const item of underscore.body.items) {
      expect(item.username).toContain("_");
    }
  });

  test("userId, totals и неверные параметры", async () => {
    const operator = await createUser({ isOperator: true });
    const seeded = await seedUsers(4);
    const target = seeded[2];

    const single = await listPage(operator, { userId: target.id });
    expect(single.body.items.map((item: { id: string }) => item.id)).toEqual([target.id]);
    expect(single.body.totals.users).toBe(5);

    const ignoredSearch = await listPage(operator, {
      userId: target.id,
      q: "несуществующий",
    });
    expect(ignoredSearch.body.items.map((item: { id: string }) => item.id)).toEqual([
      target.id,
    ]);
    expect(ignoredSearch.body.nextCursor).toBeNull();

    const filtered = await listPage(operator, { q: "несуществующий" });
    expect(filtered.body.items).toEqual([]);
    expect(filtered.body.totals).toEqual({ users: 5, operators: 1, blocked: 0 });

    const invalid: Array<Record<string, string>> = [
      { limit: "0" },
      { limit: "101" },
      { cursor: "xxx" },
      { userId: "not-a-uuid" },
    ];
    for (const params of invalid) {
      const result = await listPage(operator, params);
      expect(result.status, JSON.stringify(params)).toBe(400);
      expect(result.body.error.code).toBe("invalid_request");
    }
  });

  test("sessionCount и stuckDeletions считают только нужные сессии", async () => {
    const operator = await createUser({ isOperator: true });
    const target = await createUser();
    const sessions = [];
    for (let index = 0; index < 4; index += 1) {
      const { id } = await createSessionAs(target);
      sessions.push(id);
    }
    await db().update(appSessions).set({ eveSessionId: "visible-eve" })
      .where(eq(appSessions.id, sessions[0]!));
    await db().update(appSessions).set({ deletedAt: new Date() })
      .where(eq(appSessions.id, sessions[1]!));
    await db().update(appSessions).set({ eveSessionId: "deleted-eve", deletedAt: new Date() })
      .where(eq(appSessions.id, sessions[2]!));
    await db().update(appSessions).set({ eveSessionId: "old-deleted", deletedAt: new Date(Date.now() - 2 * 60 * 60 * 1000) })
      .where(eq(appSessions.id, sessions[3]!));

    const result = await listPage(operator, { userId: target.id });
    expect(result.body.items[0].sessionCount).toBe(1);
    expect(result.body.items[0].stuckDeletions).toBe(1);
  });

  test("тело ответа не содержит названий и текстов сессий", async () => {
    const operator = await createUser({ isOperator: true });
    const target = await createUser({ name: "Секретный пользователь" });
    const { id } = await createSessionAs(target);
    await db().update(appSessions).set({ title: "Секретный заголовок" })
      .where(eq(appSessions.id, id));
    await db().insert(sessionEvents).values({
      appSessionId: id,
      seq: 0,
      payload: { type: "message.received", text: "Тайный текст переписки" },
    });

    const result = await listPage(operator);
    expect(result.status).toBe(200);
    expect(result.text).not.toContain("Секретный заголовок");
    expect(result.text).not.toContain("Тайный текст переписки");
  });
});

describe("блокировка", () => {
  test("блокировка сразу закрывает cookie, eve и вход; разблокировка возвращает", async () => {
    const operator = await createUser({ isOperator: true });
    const target = await createUser({ telegramId: Number(DEFAULT_PROFILE.id) });
    const cookie = await loginAs(target);
    const { id: appSessionId } = await createSessionAs(target);

    expect((await fetchApp("/api/auth/me", { headers: { cookie } })).status).toBe(200);
    expect((await patch(target.id, operator, true)).status).toBe(200);

    expect((await fetchApp("/api/auth/me", { headers: { cookie } })).status).toBe(403);

    const eve = await fetchApp("/eve/v1/session", {
      method: "POST",
      headers: {
        cookie,
        "content-type": "application/json",
        "x-studio-session-id": appSessionId,
      },
      body: JSON.stringify({ message: "привет" }),
    });
    expect(eve.status).toBe(403);
    expect(await eve.json()).toMatchObject({ code: "user_blocked" });

    const login = await loginViaTelegram();
    expect(login.cookie).toBeNull();
    expect(login.steps[2]!.headers.get("location")).toBe(
      `${inject("appUrl")}/login?error=blocked`,
    );

    expect((await patch(target.id, operator, false)).status).toBe(200);
    expect((await fetchApp("/api/auth/me", { headers: { cookie } })).status).toBe(200);
    expect((await patch(target.id, operator, false)).status).toBe(200);
  });

  test("409 для оператора и разблокировки удаляемого, 400 для не-булева", async () => {
    const operator = await createUser({ isOperator: true });
    const otherOperator = await createUser({ isOperator: true });
    const deleting = await createUser({ isBlocked: true, deletionRequestedAt: new Date() });

    const operatorTarget = await patch(otherOperator.id, operator, true);
    expect(operatorTarget.status).toBe(409);
    expect(await operatorTarget.json()).toMatchObject({
      error: {
        code: "conflict",
        message: "Нельзя заблокировать оператора. Сначала снимите флаг оператора в базе.",
      },
    });

    const deletingTarget = await patch(deleting.id, operator, false);
    expect(deletingTarget.status).toBe(409);
    expect(await deletingTarget.json()).toMatchObject({
      error: {
        code: "conflict",
        message: "Пользователь удаляется, разблокировать нельзя.",
      },
    });

    expect((await api(`/api/admin/users/${deleting.id}`, {
      user: operator,
      method: "PATCH",
      body: { blocked: "yes" },
    })).status).toBe(400);
    expect((await api("/api/admin/users/not-a-uuid", {
      user: operator,
      method: "PATCH",
      body: { blocked: true },
    })).status).toBe(404);
    expect((await patch(randomUUID(), operator, true)).status).toBe(404);
  });
});

interface DeletionFixture {
  target: User;
  other: User;
  sessions: Array<{ id: string; eveId: string; machineId: string }>;
  mediaIds: string[];
  prefix: string;
  cookie: string;
}

async function seedDurableSession(user: User, id: string, message: string): Promise<string> {
  await sendAndWait(user, id, message);
  await waitForStoredEvents(user, id, (events) => events.some((event) => event.payload.type === "session.waiting"));
  const [session] = await db().select({ eveSessionId: appSessions.eveSessionId })
    .from(appSessions).where(eq(appSessions.id, id));
  if (!session?.eveSessionId) throw new Error("Eve не привязала тестовую сессию");
  return session.eveSessionId;
}

async function seedDeletionFixture(): Promise<DeletionFixture> {
  const target = await createUser({ name: "Удаляемый пользователь" });
  const other = await createUser({ name: "Другой пользователь" });
  const key = await createDaytonaKey();
  fakeSandbox.setQuota("dtn_test_secret_value", { cpu: 30, memoryGb: 60, diskGb: 120 });
  const backend = getFakeBackend(
    loadConfig().fakeSandboxDir!,
    "dtn_test_secret_value",
    { cpu: 2, memoryGb: 4, diskGb: 8 },
  );

  const sessions: DeletionFixture["sessions"] = [];
  for (let index = 0; index < 7; index += 1) {
    const { id } = await createSessionAs(target);
    const eveId = await seedDurableSession(target, id, `Секрет тестовой сессии ${index}`);
    await db().update(appSessions).set({
      title: `Секрет ${index}`,
      createdAt: new Date(Date.parse("2026-02-01T00:00:00Z") + index * 1000),
      updatedAt: new Date(Date.parse("2026-02-01T00:00:00Z") + index * 1000),
    }).where(eq(appSessions.id, id));
    const machine = await backend.create({
      name: daytonaSandboxName(eveId),
      appSessionId: id,
    });
    await db().insert(sandboxes).values({
      appSessionId: id,
      daytonaKeyId: key.id,
      daytonaSandboxId: machine.id,
      state: "started",
    });
    sessions.push({ id, eveId, machineId: machine.id });
  }
  await fakeSandbox.files.write(sessions[0]!.id, "/workspace/keep.txt", "Данные песочницы");

  const prefix = `u/${target.id}/`;
  const mediaIds: string[] = [];
  for (const [kind, folder] of [
    ["upload", "uploads"],
    ["message_file", "message-files"],
    ["tool_media", "tool-media"],
    ["preview", "preview"],
  ] as const) {
    const mediaId = randomUUID();
    const objectKey = `${prefix}s/${sessions[0]!.id}/${folder}/${mediaId}/data.txt`;
    await s3().put(objectKey, "data", "text/plain");
    await db().insert(media).values({
      id: mediaId,
      userId: target.id,
      appSessionId: sessions[0]!.id,
      kind,
      objectKey,
      contentType: "text/plain",
      sizeBytes: 4,
      originalName: "data.txt",
    });
    mediaIds.push(mediaId);
    if (kind === "message_file") {
      await db().insert(messageFiles).values({
        appSessionId: sessions[0]!.id,
        messageId: "turn_0:0",
        sandboxPath: "/workspace/data.txt",
        mediaId,
        state: "ready",
      });
    }
    if (kind === "tool_media") {
      await db().insert(toolCallMedia).values({
        appSessionId: sessions[0]!.id,
        callId: "media-call",
        sandboxPath: "/workspace/data.txt",
        mediaId,
      });
    }
    if (kind === "preview") {
      await db().update(appSessions).set({ previewMediaId: mediaId })
        .where(eq(appSessions.id, sessions[0]!.id));
      await db().insert(sessionPreviewCalls).values({
        appSessionId: sessions[0]!.id,
        callId: "preview-call",
        sandboxPath: "/workspace/preview.jpg",
        result: { path: "out/preview.jpg", size: 4, contentType: "image/jpeg" },
      });
    }
  }

  await db().insert(bashJobs).values({
    appSessionId: sessions[1]!.id,
    jobId: "abcdef12",
    status: "running",
  });
  await db().insert(agentSessions).values({
    appSessionId: sessions[2]!.id,
    eveSessionId: `copy-${randomUUID()}`,
    callId: "agent-call",
    name: "Копия",
  });
  await db().insert(queueEntries).values({
    appSessionId: sessions[3]!.id,
    userId: target.id,
    need: "create",
  });
  await db().insert(userMemory).values({
    userId: target.id,
    text: "Любит короткие ролики",
  });
  await db().insert(memoryRecallSnapshots).values({
    operationId: `measure-${randomUUID()}`,
    userId: target.id,
    content: "Сохранённые предпочтения",
  });

  const otherSession = await createSessionAs(other);
  await s3().put(`u/${other.id}/s/${otherSession.id}/uploads/keep.txt`, "keep");
  const otherMachine = await backend.create({
    name: daytonaSandboxName(`other-${randomUUID()}`),
    appSessionId: otherSession.id,
  });
  const otherKey = await createDaytonaKey();
  await db().insert(sandboxes).values({
    appSessionId: otherSession.id,
    daytonaKeyId: otherKey.id,
    daytonaSandboxId: otherMachine.id,
    state: "started",
  });

  const cookie = await loginAs(target);
  return { target, other, sessions, mediaIds, prefix, cookie };
}

describe("удаление пользователя", () => {
  test("две пачки по пять, каскад, S3, семь песочниц и чужие данные", async () => {
    const operator = await createUser({ isOperator: true });
    const fixture = await seedDeletionFixture();

    const first = await remove(fixture.target.id, operator);
    expect(first.status).toBe(202);
    expect(await first.json()).toEqual({
      done: false,
      deleted: 5,
      total: 7,
      remaining: { sessions: 2 },
    });

    const [marked] = await db().select().from(users).where(eq(users.id, fixture.target.id));
    expect(marked.isBlocked).toBe(true);
    expect(marked.deletionRequestedAt).toBeInstanceOf(Date);
    expect([401, 403]).toContain(
      (await fetchApp("/api/auth/me", { headers: { cookie: fixture.cookie } })).status,
    );

    const listed = await api("/api/admin/users", { user: operator });
    const listBody = (await listed.json()) as {
      items: Array<{ id: string; deletionRequestedAt: string | null }>;
    };
    expect(
      listBody.items.find((item) => item.id === fixture.target.id)?.deletionRequestedAt,
    ).not.toBeNull();

    const second = await remove(fixture.target.id, operator);
    expect(second.status).toBe(204);

    expect(await db().select().from(users).where(eq(users.id, fixture.target.id))).toHaveLength(0);

    const userTables = await getSqlClient()<{ table_name: string }[]>`select table_name
      from information_schema.columns
      where table_schema = 'public' and column_name = 'user_id'
        and table_name <> 'late_upload_cleanups'`;
    for (const { table_name } of userTables) {
      const rows = await getSqlClient()<{ count: number }[]>`
        select count(*)::int as count from ${getSqlClient()(table_name)}
        where user_id = ${fixture.target.id}`;
      expect(rows[0]!.count, table_name).toBe(0);
    }
    // Единственное исключение — квитанция для позднего подписанного PUT.
    expect(await getSqlClient()`select id from late_upload_cleanups where user_id = ${fixture.target.id}`)
      .toEqual([{ id: fixture.sessions[0]!.id }]);

    const sessionTables = await getSqlClient()<{ table_name: string }[]>`select table_name
      from information_schema.columns
      where table_schema = 'public' and column_name = 'app_session_id'`;
    for (const session of fixture.sessions) {
      for (const { table_name } of sessionTables) {
        const rows = await getSqlClient()<{ count: number }[]>`
          select count(*)::int as count from ${getSqlClient()(table_name)}
          where app_session_id = ${session.id}`;
        expect(rows[0]!.count, `${table_name} ${session.id}`).toBe(0);
      }
    }

    expect(await s3().listKeys(fixture.prefix)).toEqual([]);
    expect((await fakeSandbox.counters()).deleted).toBe(7);
    expect(await db().select().from(authSessions).where(eq(authSessions.userId, fixture.target.id)))
      .toHaveLength(0);

    expect(await db().select().from(users).where(eq(users.id, fixture.other.id))).toHaveLength(1);
    expect(await s3().listKeys(`u/${fixture.other.id}/`)).toHaveLength(1);
    expect((await fakeSandbox.counters()).deleted).toBe(7);

    expect((await remove(fixture.target.id, operator)).status).toBe(404);
  }, 180_000);

  test("сбой удаления песочницы: 502, метка удаления, повтор доделывает", async () => {
    const operator = await createUser({ isOperator: true });
    const target = await createUser({ name: "Сбойная песочница" });
    const key = await createDaytonaKey();
    fakeSandbox.setQuota("dtn_test_secret_value", { cpu: 30, memoryGb: 60, diskGb: 120 });
    const backend = getFakeBackend(
      loadConfig().fakeSandboxDir!,
      "dtn_test_secret_value",
      { cpu: 2, memoryGb: 4, diskGb: 8 },
    );
    const { id } = await createSessionAs(target);
    const eveId = await seedDurableSession(target, id, "Сбой при удалении");
    const machine = await backend.create({ name: daytonaSandboxName(eveId), appSessionId: id });
    await db().insert(sandboxes).values({
      appSessionId: id,
      daytonaKeyId: key.id,
      daytonaSandboxId: machine.id,
      state: "started",
    });
    const cookie = await loginAs(target);

    await fakeSandbox.failNextDelete("unavailable");
    const failed = await remove(target.id, operator);
    expect(failed.status).toBe(502);
    expect(await failed.json()).toMatchObject({
      error: {
        code: "upstream_error",
        message: "Не удалось удалить часть данных (сессий: 1). Повторите удаление.",
      },
    });

    const [row] = await db().select().from(users).where(eq(users.id, target.id));
    expect(row.isBlocked).toBe(true);
    expect(row.deletionRequestedAt).toBeInstanceOf(Date);
    expect([401, 403]).toContain(
      (await fetchApp("/api/auth/me", { headers: { cookie } })).status,
    );

    const listed = await api("/api/admin/users", { user: operator });
    const listBody = (await listed.json()) as {
      items: Array<{ id: string; deletionRequestedAt: string | null }>;
    };
    expect(listBody.items.find((item) => item.id === target.id)?.deletionRequestedAt)
      .not.toBeNull();

    expect((await remove(target.id, operator)).status).toBe(204);
    expect((await fakeSandbox.counters()).deleted).toBe(1);
  }, 120_000);

  test("сбой очистки S3 даёт 502 и повтор завершает", async () => {
    const operator = await createUser({ isOperator: true });
    const target = await createUser({ name: "Сбойное хранилище" });
    await s3().put(`u/${target.id}/uploads/keep.txt`, "keep");

    const failed = await deleteUserData(target.id, operator.id, {
      storage: {
        deletePrefix: async () => {
          throw new Error("storage unavailable");
        },
      },
    });
    expect(failed.status).toBe("failed");

    const [row] = await db().select().from(users).where(eq(users.id, target.id));
    expect(row.isBlocked).toBe(true);
    expect(row.deletionRequestedAt).toBeInstanceOf(Date);

    expect((await remove(target.id, operator)).status).toBe(204);
    expect(await db().select().from(users).where(eq(users.id, target.id))).toHaveLength(0);
    expect(await s3().listKeys(`u/${target.id}/`)).toEqual([]);

    const output = appOutput();
    expect(output).toContain("[admin:user] delete started");
    expect(output).toContain("[admin:user] delete completed");
    expect(output).toContain(target.id);
    expect(output).not.toContain(target.name);
    expect(output).not.toContain(String(target.telegramId));
  }, 120_000);

  test("оператор-цель — 409 и ничего не удалено", async () => {
    const operator = await createUser({ isOperator: true });
    const otherOperator = await createUser({ isOperator: true });
    const { id } = await createSessionAs(otherOperator);

    const response = await remove(otherOperator.id, operator);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: {
        code: "conflict",
        message: "Нельзя удалить оператора. Сначала снимите флаг оператора в базе.",
      },
    });
    expect(await db().select().from(users).where(eq(users.id, otherOperator.id))).toHaveLength(1);
    expect(await db().select().from(appSessions).where(eq(appSessions.id, id))).toHaveLength(1);
  });

  test("занятая блокировка класса 4 — 409 до каких-либо изменений", async () => {
    const operator = await createUser({ isOperator: true });
    const target = await createUser();
    const lock = await getSqlClient().reserve();
    try {
      await lock`select pg_advisory_lock(4, hashtext(${target.id}::text))`;
      const response = await remove(target.id, operator);
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        error: { code: "conflict", message: "Удаление этого пользователя уже выполняется." },
      });
      const [row] = await db().select().from(users).where(eq(users.id, target.id));
      expect(row.isBlocked).toBe(false);
      expect(row.deletionRequestedAt).toBeNull();
    } finally {
      await lock`select pg_advisory_unlock(4, hashtext(${target.id}::text))`;
      lock.release();
    }
  });

  test("два одновременных DELETE не дают 5xx", async () => {
    const operator = await createUser({ isOperator: true });
    const target = await createUser();
    for (let index = 0; index < 7; index += 1) {
      await createSessionAs(target);
    }

    const responses = await Promise.all([
      remove(target.id, operator),
      remove(target.id, operator),
    ]);
    const statuses = responses.map((response) => response.status);
    expect(statuses.every((status) => [204, 404, 409, 202].includes(status))).toBe(true);
    expect(statuses.some((status) => status >= 500)).toBe(false);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await remove(target.id, operator);
      if (response.status === 204 || response.status === 404) break;
      expect([202, 409]).toContain(response.status);
    }
  }, 180_000);
});
