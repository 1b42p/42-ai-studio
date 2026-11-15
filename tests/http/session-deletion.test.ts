import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "node:http";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { eq } from "drizzle-orm";
import { SandboxSessionGoneError } from "eve/sandbox/provider";
import { beforeEach, describe, expect, test } from "vitest";

import { signInternalToken } from "../../lib/auth/internal-tokens";
import { loadConfig } from "../../lib/config";
import { getSqlClient } from "../../lib/db/client";
import {
  agentSessions, appSessions, bashJobs, daytonaKeys, media, messageFiles,
  pendingSandboxDeletions, queueEntries, sandboxes, toolCallMedia, type User,
} from "../../lib/db/schema";
import { DELETED_KEY_MARKER, deleteKey } from "../../agent/lib/daytona-key-pool";
import { createDaytonaLifecycle } from "../../agent/lib/daytona-provider";
import { fetchApp, startApp } from "./support/app";
import { loginAs } from "./support/auth";
import { createSessionAs, eveClientAs, readStreamUntil, sendAndWait } from "./support/chat";
import { createDaytonaKey, createUser, db, resetDatabase } from "./support/db";
import { fakeSandbox } from "./support/fake-sandbox";
import { s3 } from "./support/s3";

beforeEach(async () => {
  await resetDatabase();
  await fakeSandbox.reset();
});

async function remove(id: string, user?: User, headers: Record<string, string> = {}) {
  return fetchApp(`/api/sessions/${id}`, {
    method: "DELETE", headers: { ...(user ? { cookie: await loginAs(user) } : {}), ...headers },
  });
}

async function row(id: string) {
  return (await db().select().from(appSessions).where(eq(appSessions.id, id)))[0];
}

async function fixture(options: { sandbox?: boolean; files?: boolean } = {}) {
  const user = await createUser();
  const { id } = await createSessionAs(user);
  let key;
  if (options.sandbox) {
    key = await createDaytonaKey();
    await fakeSandbox.seed(id, { "/workspace/keep.txt": "Удаляемый файл" });
    await sendAndWait(user, id, '/tool read_file {"filePath":"/workspace/keep.txt"}');
  } else {
    await sendAndWait(user, id, "Переписка для удаления");
  }
  const prefix = `u/${user.id}/s/${id}/`;
  const mediaIds: string[] = [];
  if (options.files) {
    for (const [kind, folder] of [
      ["upload", "uploads"], ["message_file", "message-files"],
      ["tool_media", "tool-media"], ["preview", "preview"],
    ] as const) {
      const mediaId = randomUUID();
      const objectKey = `${prefix}${folder}/${mediaId}/data.txt`;
      await s3().put(objectKey, "data", "text/plain");
      await db().insert(media).values({
        id: mediaId, userId: user.id, appSessionId: id, kind, objectKey,
        contentType: "text/plain", sizeBytes: 4, originalName: "data.txt",
      });
      mediaIds.push(mediaId);
      if (kind === "message_file") await db().insert(messageFiles).values({
        appSessionId: id, messageId: "turn_0:0", sandboxPath: "/workspace/data.txt", mediaId, state: "ready",
      });
      if (kind === "tool_media") await db().insert(toolCallMedia).values({
        appSessionId: id, callId: "media-call", sandboxPath: "/workspace/preview.png", mediaId,
      });
      // #18 может появиться позднее: цикл media ↔ preview проверяется, как
      // только колонка существует, без отключения остальных проверок каскада.
      if (kind === "preview") {
        const column = await getSqlClient()`select 1 from information_schema.columns
          where table_schema = 'public' and table_name = 'app_sessions' and column_name = 'preview_media_id'`;
        if (column.length) await getSqlClient()`update app_sessions set preview_media_id = ${mediaId} where id = ${id}`;
      }
    }
  }
  return { id, user, key, prefix, mediaIds, eveId: (await row(id))!.eveSessionId! };
}

async function expectHidden(id: string, user: User, mediaIds: string[] = []) {
  const cookie = await loginAs(user);
  for (const path of [
    `/api/sessions/${id}`, `/api/sessions/${id}/events`, `/api/sessions/${id}/files`,
    `/api/sessions/${id}/jobs/abcdef12`, `/s/${id}`,
    ...mediaIds.map((mediaId) => `/api/media/${mediaId}`),
  ]) {
    expect((await fetchApp(path, { headers: { cookie } })).status, path).toBe(404);
  }
  const listed = await fetchApp("/api/sessions", { headers: { cookie } });
  expect((await listed.json()).items.some((item: { id: string }) => item.id === id)).toBe(false);
}

/** Настоящий клиент S3 приложения, управляемая HTTP-граница хранилища. */
async function storageFailureStub(state: { prefix: string; mode: "partial" | "final"; lists: number }) {
  const xml = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;");
  const server = createServer(async (request, response) => {
    response.setHeader("Content-Type", "application/xml");
    try {
      if (request.method === "HEAD") { response.end(); return; }
      const url = new URL(request.url!, "http://127.0.0.1");
      if (request.method === "GET" && url.searchParams.has("list-type")) {
        state.lists++;
        if (state.mode === "final" && state.lists > 1) {
          // Уже после шага 5 появляется поздний объект, который должен
          // убрать повтор по журналу, а не по уже отсутствующей app_sessions.
          await s3().put(`${state.prefix}message-files/late.txt`, "late");
          response.writeHead(503);
          response.end("<Error><Code>ServiceUnavailable</Code></Error>");
          return;
        }
        const keys = await s3().listKeys(state.prefix);
        response.end(`<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><IsTruncated>false</IsTruncated>${
          keys.map((key) => `<Contents><Key>${xml(key)}</Key><Size>4</Size></Contents>`).join("")
        }</ListBucketResult>`);
        return;
      }
      if (request.method === "POST" && url.searchParams.has("delete")) {
        // Дочитываем тело запроса до ответа, как настоящий S3.
        for await (const chunk of request) void chunk;
        if (state.mode === "partial") {
          response.end(`<DeleteResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Error><Key>${xml(state.prefix)}uploads/keep.txt</Key><Code>AccessDenied</Code></Error></DeleteResult>`);
        } else {
          await s3().deletePrefix(state.prefix);
          response.end('<DeleteResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"/>');
        }
        return;
      }
      response.writeHead(400);
      response.end("<Error><Code>InvalidRequest</Code></Error>");
    } catch {
      response.writeHead(500);
      response.end("<Error><Code>InternalError</Code></Error>");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No S3 stub port");
  return {
    url: `http://127.0.0.1:${address.port}`,
    stop: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    }),
  };
}

describe("удаление всех данных сессии", () => {
  test("каскад, четыре вида S3, fake-каталог и eve; другая сессия не затронута", async () => {
    const target = await fixture({ sandbox: true, files: true });
    const other = await createSessionAs(target.user);
    await sendAndWait(target.user, other.id, "Другая переписка");
    const otherKey = `u/${target.user.id}/s/${other.id}/uploads/keep.txt`;
    await s3().put(otherKey, "keep");
    await db().insert(bashJobs).values({ appSessionId: target.id, jobId: "abcdef12", status: "running" });
    await db().insert(agentSessions).values({
      appSessionId: target.id, eveSessionId: `copy-${randomUUID()}`, callId: "agent-call", name: "Копия",
    });
    await db().insert(queueEntries).values({ appSessionId: target.id, userId: target.user.id, need: "create" });
    const [sandbox] = await db().select().from(sandboxes).where(eq(sandboxes.appSessionId, target.id));

    expect((await remove(target.id, target.user)).status).toBe(204);
    expect(await row(target.id)).toBeUndefined();
    expect(await s3().listKeys(target.prefix)).toEqual([]);
    expect((await fakeSandbox.counters()).deleted).toBe(1);
    expect((await fakeSandbox.calls(target.id)).filter((call) => call.op === "delete"))
      .toEqual([expect.objectContaining({ wait: true, timeout: expect.any(Number) })]);
    await expect(access(join(loadConfig().fakeSandboxDir!, "machines", sandbox.daytonaSandboxId))).rejects.toThrow();
    const dependentTables = await getSqlClient()<{ table_name: string }[]>`select table_name
      from information_schema.columns where table_schema = 'public' and column_name = 'app_session_id'`;
    for (const { table_name: table } of dependentTables) {
      const sql = getSqlClient();
      const rows = await sql`select count(*)::int as count from ${sql(table)} where app_session_id = ${target.id}`;
      expect(rows[0].count, table).toBe(0);
    }
    await expectHidden(target.id, target.user, target.mediaIds);
    expect(await row(other.id)).toBeDefined();
    expect(await s3().exists(otherKey)).toBe(true);
    const token = await signInternalToken("eve_session_end", { sid: target.eveId });
    const reset = await fetchApp(`/eve/v1/session/${target.eveId}/reset`, {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "already_deleted" }),
    });
    expect(reset.status).toBe(200);
    expect(await reset.json()).toMatchObject({ status: "no_active_session" });
    const cookie = await loginAs(target.user);
    for (const [method, path] of [["GET", `/eve/v1/session/${target.eveId}/stream`], ["POST", `/eve/v1/session/${target.eveId}`]]) {
      const denied = await fetchApp(path, { method, headers: { cookie, "Content-Type": "application/json" },
        ...(method === "POST" ? { body: JSON.stringify({ message: "Поздний запрос" }) } : {}) });
      expect(denied.status).toBe(403);
      expect(await denied.json()).toMatchObject({ code: "session_forbidden" });
    }
    expect((await remove(target.id, target.user)).status).toBe(404);
  }, 120_000);

  test("вход, блокировка, Origin, чужой владелец и неверный uuid", async () => {
    const owner = await createUser();
    const stranger = await createUser();
    const blocked = await createUser({ isBlocked: true });
    const { id } = await createSessionAs(owner);
    expect((await remove(id)).status).toBe(401);
    expect((await remove(id, stranger)).status).toBe(404);
    expect((await remove(id, blocked)).status).toBe(403);
    expect((await remove(id, owner, { origin: "https://evil.example" })).status).toBe(403);
    expect((await remove("not-uuid", owner)).status).toBe(404);
    expect((await row(id))!.deletedAt).toBeNull();
  });

  test("создающаяся eve-сессия даёт 409 до метки, старое окно не мешает удалению", async () => {
    const user = await createUser();
    const { id } = await createSessionAs(user);
    await db().update(appSessions).set({ startRequestedAt: new Date() }).where(eq(appSessions.id, id));
    const conflict = await remove(id, user);
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ error: { message: "Сессия ещё создаётся, повторите через несколько секунд." } });
    expect((await row(id))!.deletedAt).toBeNull();
    await db().update(appSessions).set({ startRequestedAt: new Date(Date.now() - 61_000) }).where(eq(appSessions.id, id));
    expect((await remove(id, user)).status).toBe(204);
    expect((await fakeSandbox.counters()).deleted).toBe(0);
  });

  test("пустая сессия удаляется без eve/Daytona и параллельный повтор безопасен", async () => {
    const user = await createUser();
    const { id } = await createSessionAs(user);
    const responses = await Promise.all([remove(id, user), remove(id, user)]);
    const statuses = responses.map((response) => response.status);
    expect(statuses).toContain(204);
    expect(statuses.every((status) => [204, 404, 409].includes(status))).toBe(true);
  });

  test("класс 2 занят: 409, без метки и побочных эффектов", async () => {
    const user = await createUser();
    const { id } = await createSessionAs(user);
    const lock = await getSqlClient().reserve();
    try {
      await lock`select pg_advisory_lock(2, hashtext(${id}::text))`;
      const response = await remove(id, user);
      expect(response.status).toBe(409);
      expect((await row(id))!.deletedAt).toBeNull();
    } finally {
      await lock`select pg_advisory_unlock(2, hashtext(${id}::text))`;
      lock.release();
    }
  });

  test("ожидание класса 1 ограничено 30 секундами, фоновых удалений после 502 нет", async () => {
    const user = await createUser();
    const { id } = await createSessionAs(user);
    const prefix = `u/${user.id}/s/${id}/`;
    await s3().put(`${prefix}uploads/keep.txt`, "keep");
    const lock = await getSqlClient().reserve();
    try {
      await lock`select pg_advisory_lock(1, hashtext(${id}::text))`;
      const start = performance.now();
      expect((await remove(id, user)).status).toBe(502);
      expect(performance.now() - start).toBeLessThan(35_000);
      expect((await row(id))!.deletedAt).toBeInstanceOf(Date);
      expect(await s3().listKeys(prefix)).toHaveLength(1);
    } finally {
      await lock`select pg_advisory_unlock(1, hashtext(${id}::text))`;
      lock.release();
    }
    expect((await remove(id, user)).status).toBe(204);
  }, 45_000);

  for (const kind of ["unavailable", "conflict"] as const) {
    test(`Daytona ${kind}: 502 скрывает сессию, повтор доделывает`, async () => {
      const target = await fixture({ sandbox: true, files: true });
      await fakeSandbox.failNextDelete(kind);
      expect((await remove(target.id, target.user)).status).toBe(502);
      expect((await row(target.id))!.deletedAt).toBeInstanceOf(Date);
      expect(await s3().listKeys(target.prefix)).toHaveLength(4);
      await expectHidden(target.id, target.user, target.mediaIds);
      expect((await remove(target.id, target.user)).status).toBe(204);
      expect((await fakeSandbox.counters()).deleted).toBe(1);
      expect(await s3().listKeys(target.prefix)).toEqual([]);
    }, 120_000);
  }

  test("404 Daytona — успех", async () => {
    const target = await fixture({ sandbox: true });
    await fakeSandbox.failNextDelete("not_found");
    expect((await remove(target.id, target.user)).status).toBe(204);
  }, 90_000);

  for (const state of ["stopped", "archived"] as const) {
    test(`удаляет ${state} без запуска или восстановления`, async () => {
      const target = await fixture({ sandbox: true });
      await fakeSandbox.stop(target.id);
      if (state === "archived") await fakeSandbox.archive(target.id);
      const before = await fakeSandbox.counters();
      expect((await remove(target.id, target.user)).status).toBe(204);
      expect(await fakeSandbox.counters()).toMatchObject({ started: before.started, restored: before.restored, deleted: 1 });
    }, 90_000);
  }

  test("мягко удалённый ключ с шифротекстом всё ещё удаляет машину", async () => {
    const target = await fixture({ sandbox: true });
    await db().update(daytonaKeys).set({ deletedAt: new Date(), enabled: false }).where(eq(daytonaKeys.id, target.key!.id));
    expect((await remove(target.id, target.user)).status).toBe(204);
    expect((await fakeSandbox.counters()).deleted).toBe(1);
  }, 90_000);

  for (const retry of [false, true]) {
    test(`gone после отказа удаления ключа: машина удаляется${retry ? " при повторе" : ""}`, async () => {
      const target = await fixture({ sandbox: true, files: true });
      const [sandbox] = await db().select().from(sandboxes)
        .where(eq(sandboxes.appSessionId, target.id));
      await fakeSandbox.failNextDelete("unavailable");
      expect(await deleteKey(target.key!.id)).toEqual({ remaining: 1 });
      await expect(createDaytonaLifecycle().resume({
        kind: "session",
        session: {
          id: target.eveId,
          auth: { current: null, initiator: null },
          turn: { id: randomUUID(), sequence: 0 },
        },
        storagePath: loadConfig().fakeSandboxDir!,
        resolveProjectPath: (filename) => path.resolve(filename),
      }, { templateKey: "deletion-test", dockerfile: "", files: [] }, {
        keyId: target.key!.id,
        sandboxId: sandbox.daytonaSandboxId,
      })).rejects.toBeInstanceOf(SandboxSessionGoneError);
      expect((await db().select().from(sandboxes)
        .where(eq(sandboxes.appSessionId, target.id)))[0].state).toBe("gone");
      expect(await db().select().from(pendingSandboxDeletions)
        .where(eq(pendingSandboxDeletions.daytonaKeyId, target.key!.id))).toHaveLength(1);
      expect((await fakeSandbox.counters()).deleted).toBe(0);

      if (retry) {
        await fakeSandbox.failNextDelete("unavailable");
        expect((await remove(target.id, target.user)).status).toBe(502);
        expect((await row(target.id))!.deletedAt).toBeInstanceOf(Date);
        expect(await s3().listKeys(target.prefix)).toHaveLength(4);
        expect(await db().select().from(pendingSandboxDeletions)
          .where(eq(pendingSandboxDeletions.daytonaKeyId, target.key!.id))).toHaveLength(1);
      }
      expect((await remove(target.id, target.user)).status).toBe(204);
      expect((await fakeSandbox.counters()).deleted).toBe(1);
      await expect(access(join(loadConfig().fakeSandboxDir!, "machines", sandbox.daytonaSandboxId))).rejects.toThrow();
      expect(await db().select().from(pendingSandboxDeletions)
        .where(eq(pendingSandboxDeletions.daytonaKeyId, target.key!.id))).toHaveLength(0);
      expect(await row(target.id)).toBeUndefined();
      expect(await s3().listKeys(target.prefix)).toEqual([]);
    }, 90_000);
  }

  test("ключ с маркером deleted: шаг Daytona пропускается", async () => {
    const target = await fixture({ sandbox: true });
    // #23 уже удалил машину, затем уничтожил шифротекст.
    const { getFakeBackend } = await import("../../lib/sandbox/fake");
    const backend = getFakeBackend(loadConfig().fakeSandboxDir!, "dtn_test_secret_value", { cpu: 2, memoryGb: 4, diskGb: 8 });
    const [sandbox] = await db().select().from(sandboxes).where(eq(sandboxes.appSessionId, target.id));
    await (await backend.get(sandbox.daytonaSandboxId)).delete();
    await db().update(daytonaKeys).set({ deletedAt: new Date(), enabled: false, apiKeyEncrypted: DELETED_KEY_MARKER })
      .where(eq(daytonaKeys.id, target.key!.id));
    expect((await remove(target.id, target.user)).status).toBe(204);
    expect((await fakeSandbox.counters()).deleted).toBe(1);
  }, 90_000);

  test("S3 недоступен: tombstone и gone сохраняются; основной экземпляр доделывает", async () => {
    const target = await fixture({ sandbox: true, files: true });
    const app = await startApp({ env: { S3_ENDPOINT: "http://127.0.0.1:1" } });
    try {
      const response = await fetch(new URL(`/api/sessions/${target.id}`, app.url), {
        method: "DELETE", headers: { cookie: await loginAs(target.user) },
      });
      expect(response.status).toBe(502);
      expect((await row(target.id))!.deletedAt).toBeInstanceOf(Date);
      expect((await db().select().from(sandboxes).where(eq(sandboxes.appSessionId, target.id)))[0].state).toBe("gone");
      expect(await s3().listKeys(target.prefix)).toHaveLength(4);
      expect((await remove(target.id, target.user)).status).toBe(204);
    } finally { await app.stop(); }
  }, 300_000);

  test("частичный DeleteObjects и сбой final sweep дают 502 с устойчивым повтором", async () => {
    const user = await createUser();
    const partial = await createSessionAs(user);
    const state = { prefix: `u/${user.id}/s/${partial.id}/`, mode: "partial" as "partial" | "final", lists: 0 };
    await s3().put(`${state.prefix}uploads/keep.txt`, "keep");
    const stub = await storageFailureStub(state);
    const app = await startApp({ env: { S3_ENDPOINT: stub.url } });
    const deleting = async (id: string) => fetch(new URL(`/api/sessions/${id}`, app.url), {
      method: "DELETE", headers: { cookie: await loginAs(user) },
    });
    try {
      expect((await deleting(partial.id)).status).toBe(502);
      expect((await row(partial.id))!.deletedAt).toBeInstanceOf(Date);
      expect(await s3().listKeys(state.prefix)).toHaveLength(1);
      expect((await remove(partial.id, user)).status).toBe(204);

      const final = await createSessionAs(user);
      state.prefix = `u/${user.id}/s/${final.id}/`;
      state.mode = "final";
      state.lists = 0;
      await s3().put(`${state.prefix}uploads/keep.txt`, "keep");
      expect((await deleting(final.id)).status).toBe(502);
      expect(await row(final.id)).toBeUndefined();
      const journal = await getSqlClient()`select * from session_deletions where id = ${final.id}`;
      expect(journal).toHaveLength(1);
      expect(journal[0].user_id).toBe(user.id);
      expect(await s3().listKeys(state.prefix)).toEqual([`${state.prefix}message-files/late.txt`]);
      expect((await remove(final.id, await createUser())).status).toBe(404);
      expect((await remove(final.id, user)).status).toBe(204);
      expect(await getSqlClient()`select id from session_deletions where id = ${final.id}`).toHaveLength(0);
      expect(await s3().listKeys(state.prefix)).toEqual([]);
      expect((await remove(final.id, user)).status).toBe(404);
    } finally {
      await app.stop();
      await stub.stop();
    }
  }, 300_000);

  test("список добивает старые tombstones, но не свежие и не чужие", async () => {
    const user = await createUser();
    const foreignUser = await createUser();
    const old = await createSessionAs(user);
    const fresh = await createSessionAs(user);
    const foreign = await createSessionAs(foreignUser);
    await db().update(appSessions).set({ deletedAt: new Date(Date.now() - 121_000) }).where(eq(appSessions.id, old.id));
    await db().update(appSessions).set({ deletedAt: new Date() }).where(eq(appSessions.id, fresh.id));
    await db().update(appSessions).set({ deletedAt: new Date(Date.now() - 121_000) }).where(eq(appSessions.id, foreign.id));
    const key = `u/${user.id}/s/${old.id}/uploads/late.txt`;
    await s3().put(key, "late");
    expect((await fetchApp("/api/sessions", { headers: { cookie: await loginAs(user) } })).status).toBe(200);
    await expect.poll(() => row(old.id), { timeout: 15_000, interval: 200 }).toBeUndefined();
    expect(await s3().exists(key)).toBe(false);
    expect(await row(fresh.id)).toBeDefined();
    expect(await row(foreign.id)).toBeDefined();
  });

  test("один список добивает не больше пяти сессий и повторный список не обходит минутный затвор", async () => {
    const user = await createUser();
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) {
      const { id } = await createSessionAs(user);
      ids.push(id);
      await db().update(appSessions).set({ deletedAt: new Date(Date.now() - 180_000 + i) })
        .where(eq(appSessions.id, id));
    }
    const journalId = randomUUID();
    const journalPrefix = `u/${user.id}/s/${journalId}/`;
    await getSqlClient()`insert into session_deletions (id, user_id, created_at)
      values (${journalId}, ${user.id}, now() - interval '4 minutes')`;
    await s3().put(`${journalPrefix}message-files/late.txt`, "late");
    const cookie = await loginAs(user);
    const list = () => fetchApp("/api/sessions", { headers: { cookie } });
    await Promise.all([list(), list(), list()]);
    await expect.poll(async () => {
      const [count] = await getSqlClient()`select count(*)::int as count from app_sessions where user_id = ${user.id}`;
      return count.count;
    }, { timeout: 15_000, interval: 200 }).toBe(2);
    expect(await getSqlClient()`select id from session_deletions where id = ${journalId}`).toHaveLength(0);
    expect(await s3().listKeys(journalPrefix)).toEqual([]);
    expect(await row(ids[4])).toBeDefined();
    expect(await row(ids[5])).toBeDefined();
    await list();
    await delay(300);
    expect(await row(ids[5])).toBeDefined();
  });

  test("идущий ход не воскрешает события после удаления", async () => {
    const user = await createUser();
    const { id } = await createSessionAs(user);
    const client = await eveClientAs(user, id);
    const { response } = await client.sessions.create({ message: "/slow 20 позднее сообщение" });
    await readStreamUntil(response, "turn.started");
    expect((await remove(id, user)).status).toBe(204);
    await delay(5000);
    const [{ count }] = await getSqlClient()`select count(*)::int as count from session_events where app_session_id = ${id}`;
    expect(count).toBe(0);
  }, 45_000);

  test("20 000 событий и 100 объектов укладываются в 120 секунд", async () => {
    const user = await createUser();
    const { id } = await createSessionAs(user);
    await getSqlClient()`insert into session_events (app_session_id, seq, payload)
      select ${id}::uuid, seq, '{"type":"fixture"}'::jsonb from generate_series(0, 19999) as seq`;
    const prefix = `u/${user.id}/s/${id}/`;
    await Promise.all(Array.from({ length: 100 }, (_, i) => s3().put(`${prefix}uploads/${i}.txt`, "data")));
    const started = performance.now();
    expect((await remove(id, user)).status).toBe(204);
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(120_000);
    console.info("[session:delete:volume]", { elapsedMs: elapsed });
    expect(await s3().listKeys(prefix)).toEqual([]);
  }, 150_000);
});
