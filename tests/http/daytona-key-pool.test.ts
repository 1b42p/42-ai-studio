/**
 * Пул ключей Daytona (#23): выбор по свободной квоте, отключение и удаление,
 * фиктивный слой вместо настоящей Daytona. Точечные операции проверяются
 * в процессе теста: HTTP-маршруты для них делает админка (#32).
 */
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { eq } from "drizzle-orm";
import type { MessageStreamEvent } from "eve/client";
import type { SandboxSessionContext } from "eve/sandbox/provider";
import { beforeEach, describe, expect, test } from "vitest";

import {
  deleteKey,
  disableKey,
  enableKey,
  pickKey,
  refreshUsage,
} from "../../agent/lib/daytona-key-pool";
import { createDaytonaLifecycle } from "../../agent/lib/daytona-provider";
import { loadConfig } from "../../lib/config";
import {
  appSessions,
  daytonaKeys,
  pendingSandboxDeletions,
  sandboxes,
  type DaytonaKey,
  type User,
} from "../../lib/db/schema";
import { DAYTONA_KEY_PURPOSE, decryptSecret } from "../../lib/secrets";
import { StudioSandboxError } from "../../lib/sandbox/errors";
import { getFakeBackend } from "../../lib/sandbox/fake";
import { appOutput } from "./support/app";
import { loginAs } from "./support/auth";
import { createSessionAs, sendAndWait, sendWithFiles, waitForStoredEvents } from "./support/chat";
import { createDaytonaKey, createUser, db, resetDatabase } from "./support/db";
import { fakeSandbox } from "./support/fake-sandbox";
import { uploadBytes } from "./support/uploads";

const READ_FILE = '/tool read_file {"filePath":"/workspace/notes.txt"}';
const KEY_A = "dtn_pool_key_a";
const KEY_B = "dtn_pool_key_b";
const ONE_SLOT = { cpu: 2, memoryGb: 4, diskGb: 8 };

beforeEach(async () => {
  await resetDatabase();
  await fakeSandbox.reset();
});

function toolResult(events: readonly MessageStreamEvent[], name = "read_file") {
  const results = events.filter((event) => event.type === "action.result");
  const event = results.find(
    (event) => event.data.result.kind === "tool-result" && event.data.result.toolName === name,
  );
  expect(event, `Нет результата ${name}: ${events.map((item) => item.type).join(", ")}`).toBeDefined();
  return event!.data;
}

function expectRead(events: readonly MessageStreamEvent[], text: string) {
  const result = toolResult(events);
  expect(result.status).toBe("completed");
  expect(result.result).toMatchObject({
    kind: "tool-result",
    toolName: "read_file",
    output: { content: expect.stringContaining(text) },
  });
}

async function sandboxRow(appSessionId: string) {
  const rows = await db().select().from(sandboxes).where(eq(sandboxes.appSessionId, appSessionId));
  expect(rows).toHaveLength(1);
  return rows[0];
}

/** Ждёт строку-резерв, которую `pickKey` создаёт до машины. */
async function waitForReservation(appSessionId: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const [row] = await db().select().from(sandboxes).where(eq(sandboxes.appSessionId, appSessionId));
    if (row?.state === "starting" && row.daytonaSandboxId === "") return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Резерв не появился");
}

async function keyRow(id: string): Promise<DaytonaKey> {
  const [row] = await db().select().from(daytonaKeys).where(eq(daytonaKeys.id, id));
  expect(row, `Нет ключа ${id}`).toBeDefined();
  return row!;
}

function hasFileMessage(items: ReadonlyArray<{ payload: MessageStreamEvent }>): boolean {
  const index = items.findIndex((item) => JSON.stringify(item.payload).includes("clip.txt"));
  return index >= 0 && items.slice(index).some((item) => item.payload.type === "session.waiting");
}

async function expectNoSecret(user: User, id: string, events: readonly MessageStreamEvent[]) {
  for (const secret of [KEY_A, KEY_B]) {
    expect(JSON.stringify(events)).not.toContain(secret);
    const stored = await waitForStoredEvents(user, id, (items) =>
      items.some((item) => item.payload.type === "session.waiting"));
    expect(JSON.stringify(stored)).not.toContain(secret);
    expect(appOutput()).not.toContain(secret);
  }
}

function sessionContext(eveSessionId: string): SandboxSessionContext {
  return {
    kind: "session",
    session: {
      id: eveSessionId,
      auth: { current: null, initiator: null },
      turn: { id: randomUUID(), sequence: 0 },
    },
    storagePath: loadConfig().fakeSandboxDir!,
    resolveProjectPath: (filename: string) => path.resolve(filename),
  };
}

const ARTIFACT = {
  templateKey: "pool-test",
  dockerfile: "FROM python:3.12-slim-bookworm\nRUN mkdir -p /workspace\n",
  files: [],
};

describe("выбор ключа по свободной квоте", () => {
  test("две сессии расходятся по ключам, третья получает capacity_exhausted", async () => {
    const a = await createDaytonaKey({ label: "A", apiKey: KEY_A });
    const b = await createDaytonaKey({ label: "B", apiKey: KEY_B });
    await fakeSandbox.setQuota(KEY_A, ONE_SLOT);
    await fakeSandbox.setQuota(KEY_B, ONE_SLOT);
    const user = await createUser();

    const first = await createSessionAs(user);
    await fakeSandbox.seed(first.id, { "/workspace/notes.txt": "Первый ключ\n" });
    expectRead(await sendAndWait(user, first.id, READ_FILE), "Первый ключ");
    expect((await sandboxRow(first.id)).daytonaKeyId).toBe(a.id);

    const second = await createSessionAs(user);
    await fakeSandbox.seed(second.id, { "/workspace/notes.txt": "Второй ключ\n" });
    expectRead(await sendAndWait(user, second.id, READ_FILE), "Второй ключ");
    expect((await sandboxRow(second.id)).daytonaKeyId).toBe(b.id);

    const third = await createSessionAs(user);
    const events = await sendAndWait(user, third.id, READ_FILE);
    const result = toolResult(events);
    expect(result.status).toBe("failed");
    expect(JSON.stringify(result)).toContain(
      "capacity_exhausted: Сейчас все песочницы заняты. Попробуйте позже.",
    );

    expect((await fakeSandbox.counters()).created).toBe(2);
    // Ключ A не трогали повторно: попытки — A (первый ход), A+B (второй), B (третий).
    expect((await fakeSandbox.counters()).createAttempts).toBe(4);
    await expectNoSecret(user, third.id, events);
  }, 60_000);

  test("остановка песочницы не освобождает диск, архивация освобождает", async () => {
    const a = await createDaytonaKey({ apiKey: KEY_A });
    await fakeSandbox.setQuota(KEY_A, ONE_SLOT);
    const user = await createUser();

    const first = await createSessionAs(user);
    await fakeSandbox.seed(first.id, { "/workspace/notes.txt": "На диске\n" });
    expectRead(await sendAndWait(user, first.id, READ_FILE), "На диске");

    await fakeSandbox.stop(first.id);
    const stopped = await refreshUsage(a.id, { force: true });
    expect(stopped).toMatchObject({
      source: "daytona",
      cpu: { used: 0, quota: 2 },
      memoryGb: { used: 0, quota: 4 },
      diskGb: { used: 8, quota: 8 },
    });

    const second = await createSessionAs(user);
    const refused = await sendAndWait(user, second.id, READ_FILE);
    expect(JSON.stringify(toolResult(refused))).toContain("capacity_exhausted");
    expect((await fakeSandbox.counters()).created).toBe(1);

    await fakeSandbox.archive(first.id);
    const archived = await refreshUsage(a.id, { force: true });
    expect(archived?.diskGb).toEqual({ used: 0, quota: 8 });

    await fakeSandbox.seed(second.id, { "/workspace/notes.txt": "После архивации\n" });
    expectRead(await sendAndWait(user, second.id, READ_FILE), "После архивации");
    expect((await sandboxRow(second.id)).daytonaKeyId).toBe(a.id);
    expect((await fakeSandbox.counters()).created).toBe(2);
  }, 60_000);

  test("использование кэшируется на 30 секунд, force обходит кэш, forbidden сохраняет числа", async () => {
    const a = await createDaytonaKey({ apiKey: KEY_A });
    await fakeSandbox.setQuota(KEY_A, ONE_SLOT);

    const first = await refreshUsage(a.id);
    expect(first).toMatchObject({ source: "daytona", error: null, region: "us-east-1" });
    expect(await fakeSandbox.usageCalls(KEY_A)).toBe(1);

    await refreshUsage(a.id);
    expect(await fakeSandbox.usageCalls(KEY_A)).toBe(1);

    const latest = await refreshUsage(a.id, { force: true });
    expect(await fakeSandbox.usageCalls(KEY_A)).toBe(2);

    await fakeSandbox.failUsage(KEY_A, "forbidden");
    const failed = await refreshUsage(a.id, { force: true });
    expect(failed).toMatchObject({ source: "error", error: "forbidden", cpu: first?.cpu });
    expect(failed?.fetchedAt).toBe(latest?.fetchedAt);

    // Недоступное использование не мешает выбрать ключ с прежними числами.
    const user = await createUser();
    const session = await createSessionAs(user);
    await fakeSandbox.seed(session.id, { "/workspace/notes.txt": "С прежними числами\n" });
    expectRead(await sendAndWait(user, session.id, READ_FILE), "С прежними числами");
    expect((await sandboxRow(session.id)).daytonaKeyId).toBe(a.id);

    // Ответ 200 не по схеме доходит до `usage` как `unexpected`.
    await fakeSandbox.failUsage(KEY_A, "unexpected");
    const broken = await refreshUsage(a.id, { force: true });
    expect(broken).toMatchObject({ source: "error", error: "unexpected", cpu: first?.cpu });
  }, 60_000);

  test("резерв на замену очищает старый id машины", async () => {
    const a = await createDaytonaKey({ apiKey: KEY_A });
    const user = await createUser();
    const { id } = await createSessionAs(user);
    await db().insert(sandboxes).values({
      appSessionId: id,
      daytonaKeyId: a.id,
      daytonaSandboxId: "old-machine-id",
      state: "gone",
      lastActiveAt: new Date(),
    });

    const picked = await pickKey(ONE_SLOT, { appSessionId: id });
    expect(picked.kind).toBe("key");
    expect(await sandboxRow(id)).toMatchObject({
      daytonaKeyId: a.id,
      daytonaSandboxId: "",
      state: "starting",
    });
  });

  test("два выбора подряд в пределах 30 секунд дают один запрос использования", async () => {
    const a = await createDaytonaKey({ apiKey: KEY_A });
    await fakeSandbox.setQuota(KEY_A, { cpu: 10, memoryGb: 20, diskGb: 30 });
    const user = await createUser();
    const one = await createSessionAs(user);
    const two = await createSessionAs(user);
    const need = { cpu: 2, memoryGb: 4, diskGb: 8 };

    const first = await pickKey(need, { appSessionId: one.id });
    const second = await pickKey(need, { appSessionId: two.id });
    expect(first.kind).toBe("key");
    expect(second.kind).toBe("key");
    expect(await fakeSandbox.usageCalls(KEY_A)).toBe(1);

    await refreshUsage(a.id, { force: true });
    expect(await fakeSandbox.usageCalls(KEY_A)).toBe(2);
  });

  test("устаревшее использование: отказ по квоте помечает пул и передаёт выбор следующему ключу", async () => {
    const a = await createDaytonaKey({ label: "A", apiKey: KEY_A });
    const b = await createDaytonaKey({ label: "B", apiKey: KEY_B });
    await fakeSandbox.setQuota(KEY_A, ONE_SLOT);
    await fakeSandbox.setQuota(KEY_B, ONE_SLOT);
    const user = await createUser();

    const first = await createSessionAs(user);
    await fakeSandbox.seed(first.id, { "/workspace/notes.txt": "A\n" });
    expectRead(await sendAndWait(user, first.id, READ_FILE), "A");

    const second = await createSessionAs(user);
    await fakeSandbox.seed(second.id, { "/workspace/notes.txt": "B\n" });
    expectRead(await sendAndWait(user, second.id, READ_FILE), "B");
    expect((await sandboxRow(second.id)).daytonaKeyId).toBe(b.id);

    const exhausted = await keyRow(a.id);
    expect(exhausted.exhaustedUntil).not.toBeNull();
    expect(exhausted.exhaustedUntil!.getTime()).toBeGreaterThan(Date.now() + 50_000);

    const third = await createSessionAs(user);
    expect(JSON.stringify(toolResult(await sendAndWait(user, third.id, READ_FILE))))
      .toContain("capacity_exhausted");
    // B — последняя попытка; исчерпанный A заново не выбирался.
    expect((await fakeSandbox.counters()).createAttempts).toBe(4);
  }, 60_000);
});

describe("отключение и удаление", () => {
  test("отключённый ключ не берёт новые песочницы, но просыпает свою", async () => {
    const a = await createDaytonaKey({ label: "A", apiKey: KEY_A });
    const b = await createDaytonaKey({ label: "B", apiKey: KEY_B });
    await fakeSandbox.setQuota(KEY_A, ONE_SLOT);
    await fakeSandbox.setQuota(KEY_B, ONE_SLOT);
    const user = await createUser();

    const first = await createSessionAs(user);
    await fakeSandbox.seed(first.id, { "/workspace/notes.txt": "Файл на A\n" });
    expectRead(await sendAndWait(user, first.id, READ_FILE), "Файл на A");
    const original = await sandboxRow(first.id);
    expect(original.daytonaKeyId).toBe(a.id);

    await fakeSandbox.stop(first.id);
    await disableKey(a.id);
    expect((await keyRow(a.id)).enabled).toBe(false);

    expectRead(await sendAndWait(user, first.id, READ_FILE), "Файл на A");
    expect((await sandboxRow(first.id)).daytonaSandboxId).toBe(original.daytonaSandboxId);

    const second = await createSessionAs(user);
    await fakeSandbox.seed(second.id, { "/workspace/notes.txt": "Новая на B\n" });
    expectRead(await sendAndWait(user, second.id, READ_FILE), "Новая на B");
    expect((await sandboxRow(second.id)).daytonaKeyId).toBe(b.id);

    await enableKey(a.id);
    expect((await keyRow(a.id)).enabled).toBe(true);
  }, 60_000);

  test("включение возвращает ключ в выбор", async () => {
    const a = await createDaytonaKey({ apiKey: KEY_A });
    await fakeSandbox.setQuota(KEY_A, ONE_SLOT);
    const user = await createUser();
    const { id } = await createSessionAs(user);

    await disableKey(a.id);
    expect((await pickKey(ONE_SLOT, { appSessionId: id })).kind).toBe("no_key");

    await enableKey(a.id);
    const picked = await pickKey(ONE_SLOT, { appSessionId: id });
    expect(picked.kind).toBe("key");
    if (picked.kind === "key") expect(picked.key.id).toBe(a.id);
  });

  test("удаление: маркер deleted, песочницы удалены, сессия получает новую на другом ключе", async () => {
    const a = await createDaytonaKey({ label: "A", apiKey: KEY_A });
    const b = await createDaytonaKey({ label: "B", apiKey: KEY_B });
    await fakeSandbox.setQuota(KEY_A, ONE_SLOT);
    await fakeSandbox.setQuota(KEY_B, ONE_SLOT);
    const user = await createUser();

    const { id } = await createSessionAs(user);
    await fakeSandbox.seed(id, { "/workspace/notes.txt": "Исчезнет вместе с A\n" });
    expectRead(await sendAndWait(user, id, READ_FILE), "Исчезнет вместе с A");

    const body = "данные";
    const ticket = await uploadBytes(
      user,
      { appSessionId: id, name: "clip.txt", contentType: "text/plain", sizeBytes: Buffer.byteLength(body) },
      body,
    );
    const fileEvents = await sendWithFiles(user, id, "", [ticket.id]);
    expect(JSON.stringify(fileEvents)).toContain("clip.txt");
    const before = await waitForStoredEvents(user, id, hasFileMessage);
    const beforeCreated = (await fakeSandbox.counters()).created;

    const result = await deleteKey(a.id);
    expect(result).toEqual({ remaining: 0 });
    const deleted = await keyRow(a.id);
    expect(deleted.apiKeyEncrypted).toBe("deleted");
    expect(deleted.deletedAt).not.toBeNull();
    expect(deleted.enabled).toBe(false);
    expect(() =>
      decryptSecret(deleted.apiKeyEncrypted, loadConfig().secretsEncryptionKey, DAYTONA_KEY_PURPOSE),
    ).toThrow();
    expect((await fakeSandbox.counters()).deleted).toBeGreaterThan(0);

    const after = await waitForStoredEvents(user, id, hasFileMessage);
    expect(after).toEqual(before);

    const media = await fetch(
      new URL(`/api/media/${ticket.id}`, loadConfig().appUrl),
      { headers: { cookie: await loginAs(user) }, redirect: "manual" },
    );
    expect(media.status).toBe(302);

    const renewed = await sendAndWait(user, id, READ_FILE);
    const tool = toolResult(renewed);
    expect(tool.status).toBe("failed");
    expect(JSON.stringify(tool)).not.toContain("Исчезнет вместе с A");
    expect((await sandboxRow(id)).daytonaKeyId).toBe(b.id);
    expect((await fakeSandbox.counters()).created).toBe(beforeCreated + 1);
    expect(await fakeSandbox.files.read(id, "/workspace/notes.txt")).toBeNull();
  }, 90_000);

  test("удаление забирает машину у строки, которую уже пометили gone", async () => {
    const a = await createDaytonaKey({ apiKey: KEY_A });
    await fakeSandbox.setQuota(KEY_A, ONE_SLOT);
    const user = await createUser();
    const { id } = await createSessionAs(user);
    await fakeSandbox.seed(id, { "/workspace/notes.txt": "Строка gone, машина жива\n" });
    expectRead(await sendAndWait(user, id, READ_FILE), "Строка gone, машина жива");
    const original = await sandboxRow(id);
    await db().update(sandboxes).set({ state: "gone" }).where(eq(sandboxes.id, original.id));

    expect(await deleteKey(a.id)).toEqual({ remaining: 0 });
    expect((await keyRow(a.id)).apiKeyEncrypted).toBe("deleted");
    expect((await fakeSandbox.counters()).deleted).toBe(1);
  }, 60_000);

  test("удаление ключа во время создания уводит сессию на другой ключ", async () => {
    const a = await createDaytonaKey({ label: "A", apiKey: KEY_A });
    const b = await createDaytonaKey({ label: "B", apiKey: KEY_B });
    await fakeSandbox.setQuota(KEY_A, ONE_SLOT);
    await fakeSandbox.setQuota(KEY_B, ONE_SLOT);
    const user = await createUser();
    const eveSessionId = randomUUID();
    const [session] = await db().insert(appSessions).values({ userId: user.id, eveSessionId }).returning();
    await fakeSandbox.setCreateDelay(1200);
    const lifecycle = createDaytonaLifecycle();
    const starting = lifecycle.start(sessionContext(eveSessionId), undefined, ARTIFACT);
    try {
      await waitForReservation(session!.id);
      expect(await deleteKey(a.id)).toEqual({ remaining: 1 });

      const opened = await starting;
      await opened.connection.close?.();
      expect(opened.state.keyId).toBe(b.id);
      expect(await sandboxRow(session!.id)).toMatchObject({ daytonaKeyId: b.id, state: "started" });
      expect((await fakeSandbox.counters()).created).toBe(2);
      expect((await fakeSandbox.counters()).deleted).toBe(1);

      expect(await deleteKey(a.id)).toEqual({ remaining: 0 });
      expect((await keyRow(a.id)).apiKeyEncrypted).toBe("deleted");
    } catch (error) {
      await starting.catch(() => {});
      throw error;
    }
  }, 60_000);

  test("неудалённое удаление запоминается и повторяется после смены песочницы", async () => {
    const a = await createDaytonaKey({ label: "A", apiKey: KEY_A });
    const b = await createDaytonaKey({ label: "B", apiKey: KEY_B });
    await fakeSandbox.setQuota(KEY_A, ONE_SLOT);
    await fakeSandbox.setQuota(KEY_B, ONE_SLOT);
    const user = await createUser();

    const { id } = await createSessionAs(user);
    await fakeSandbox.seed(id, { "/workspace/notes.txt": "На старой машине\n" });
    expectRead(await sendAndWait(user, id, READ_FILE), "На старой машине");
    const original = await sandboxRow(id);
    expect(original.daytonaKeyId).toBe(a.id);

    await fakeSandbox.failNextDelete("unavailable");
    expect(await deleteKey(a.id)).toEqual({ remaining: 1 });
    const pending = await db()
      .select()
      .from(pendingSandboxDeletions)
      .where(eq(pendingSandboxDeletions.daytonaKeyId, a.id));
    expect(pending.map((row) => row.daytonaSandboxId)).toEqual([original.daytonaSandboxId]);
    expect((await keyRow(a.id)).apiKeyEncrypted).not.toBe("deleted");

    // Сессия уходит с удалённого ключа на B, строка теряет старый id.
    const renewed = await sendAndWait(user, id, READ_FILE);
    expect(toolResult(renewed).status).toBe("failed");
    expect((await sandboxRow(id)).daytonaKeyId).toBe(b.id);

    expect(await deleteKey(a.id)).toEqual({ remaining: 0 });
    expect((await keyRow(a.id)).apiKeyEncrypted).toBe("deleted");
    expect(await db()
      .select()
      .from(pendingSandboxDeletions)
      .where(eq(pendingSandboxDeletions.daytonaKeyId, a.id))).toHaveLength(0);
    expect((await fakeSandbox.counters()).deleted).toBe(1);
  }, 60_000);
});

describe("организации и отказы", () => {
  test("ключи одной организации делят квоту: второй не выбирается, пока пул исчерпан", async () => {
    const first = await createDaytonaKey({ label: "A1", apiKey: KEY_A });
    const second = await createDaytonaKey({ label: "A2", apiKey: KEY_B });
    await fakeSandbox.setOrganization(KEY_A, "org-shared");
    await fakeSandbox.setOrganization(KEY_B, "org-shared");
    await fakeSandbox.setQuota(KEY_A, ONE_SLOT);
    // B сам по себе вместил бы ещё песочницу; выбор обязан идти по
    // представителю пула A, а не по квоте второго ключа.
    await fakeSandbox.setQuota(KEY_B, { cpu: 10, memoryGb: 20, diskGb: 30 });
    const user = await createUser();

    const one = await createSessionAs(user);
    await fakeSandbox.seed(one.id, { "/workspace/notes.txt": "Первый\n" });
    expectRead(await sendAndWait(user, one.id, READ_FILE), "Первый");
    expect((await sandboxRow(one.id)).daytonaKeyId).toBe(first.id);

    const two = await createSessionAs(user);
    expect(JSON.stringify(toolResult(await sendAndWait(user, two.id, READ_FILE))))
      .toContain("capacity_exhausted");
    expect((await fakeSandbox.counters()).created).toBe(1);
    // Первый ход создал A (1 попытка), второй упёрся в квоту A (2-я) и не
    // пробовал B: иначе была бы третья попытка и вторая песочница.
    expect((await fakeSandbox.counters()).createAttempts).toBe(2);
    // Представитель пула исчерпан — второй ключ той же организации пропущен.
    expect((await keyRow(first.id)).exhaustedUntil).not.toBeNull();
    expect((await keyRow(second.id)).exhaustedUntil).not.toBeNull();
  }, 60_000);

  test("unauthorized у первого ключа пропускает его", async () => {
    const a = await createDaytonaKey({ label: "A", apiKey: KEY_A });
    const b = await createDaytonaKey({ label: "B", apiKey: KEY_B });
    await fakeSandbox.setQuota(KEY_A, ONE_SLOT);
    await fakeSandbox.setQuota(KEY_B, ONE_SLOT);
    await fakeSandbox.failUsage(KEY_A, "unauthorized");
    const user = await createUser();

    const { id } = await createSessionAs(user);
    await fakeSandbox.seed(id, { "/workspace/notes.txt": "На живом ключе\n" });
    expectRead(await sendAndWait(user, id, READ_FILE), "На живом ключе");
    expect((await sandboxRow(id)).daytonaKeyId).toBe(b.id);
    expect(await keyRow(a.id)).toMatchObject({ usage: { error: "unauthorized" } });
  }, 60_000);

  test("401 при создании исключает ключ и передаёт выбор следующему", async () => {
    const a = await createDaytonaKey({ label: "A", apiKey: KEY_A });
    const b = await createDaytonaKey({ label: "B", apiKey: KEY_B });
    await fakeSandbox.setQuota(KEY_A, ONE_SLOT);
    await fakeSandbox.setQuota(KEY_B, ONE_SLOT);
    await fakeSandbox.failNextCreate("unauthorized");
    const user = await createUser();

    const { id } = await createSessionAs(user);
    await fakeSandbox.seed(id, { "/workspace/notes.txt": "На втором ключе\n" });
    expectRead(await sendAndWait(user, id, READ_FILE), "На втором ключе");
    expect((await sandboxRow(id)).daytonaKeyId).toBe(b.id);
    expect(await keyRow(a.id)).toMatchObject({ usage: { error: "unauthorized" } });
    expect((await fakeSandbox.counters()).created).toBe(1);
  }, 60_000);

  test("400 без признака квоты не помечает пул и даёт sandbox_create_failed", async () => {
    const a = await createDaytonaKey({ apiKey: KEY_A });
    await fakeSandbox.failNextCreate("error");
    const user = await createUser();
    const { id } = await createSessionAs(user);

    const events = await sendAndWait(user, id, READ_FILE);
    expect(JSON.stringify(toolResult(events))).toContain("sandbox_create_failed");
    const key = await keyRow(a.id);
    expect(key.exhaustedUntil).toBeNull();
    expect((await fakeSandbox.counters()).createAttempts).toBe(1);
  }, 60_000);
});

test("машина, созданная до записи id, восстанавливается по имени без места в пуле", async () => {
  const a = await createDaytonaKey({ apiKey: KEY_A });
  await fakeSandbox.setQuota(KEY_A, ONE_SLOT);
  const user = await createUser();
  const eveSessionId = randomUUID();
  const [session] = await db().insert(appSessions).values({ userId: user.id, eveSessionId }).returning();
  const name = `studio-${createHash("sha256").update(eveSessionId).digest("hex").slice(0, 32)}`;
  const backend = getFakeBackend(loadConfig().fakeSandboxDir!, KEY_A, ONE_SLOT);
  const machine = await backend.create({ name, appSessionId: session!.id });
  await db().insert(sandboxes).values({
    appSessionId: session!.id,
    daytonaKeyId: a.id,
    daytonaSandboxId: "",
    state: "starting",
    startingSince: new Date(),
    startingKind: "create",
  });

  const started = await createDaytonaLifecycle().start(sessionContext(eveSessionId), undefined, ARTIFACT);
  try {
    expect(started.state.sandboxId).toBe(machine.id);
    expect(await sandboxRow(session!.id)).toMatchObject({
      daytonaKeyId: a.id,
      daytonaSandboxId: machine.id,
      state: "started",
    });
    expect((await fakeSandbox.counters()).created).toBe(1);
  } finally {
    await started.connection.close?.();
  }
}, 60_000);

test("машина удалённого ключа, не записанная до падения, убирается при восстановлении", async () => {
  const a = await createDaytonaKey({ label: "A", apiKey: KEY_A });
  const b = await createDaytonaKey({ label: "B", apiKey: KEY_B });
  await fakeSandbox.setQuota(KEY_A, ONE_SLOT);
  await fakeSandbox.setQuota(KEY_B, ONE_SLOT);
  const user = await createUser();
  const eveSessionId = randomUUID();
  const [session] = await db().insert(appSessions).values({ userId: user.id, eveSessionId }).returning();
  const name = `studio-${createHash("sha256").update(eveSessionId).digest("hex").slice(0, 32)}`;
  const backend = getFakeBackend(loadConfig().fakeSandboxDir!, KEY_A, ONE_SLOT);
  await backend.create({ name, appSessionId: session!.id });
  await db().insert(sandboxes).values({
    appSessionId: session!.id,
    daytonaKeyId: a.id,
    daytonaSandboxId: "",
    state: "starting",
    startingSince: new Date(),
    startingKind: "create",
  });
  await db().update(daytonaKeys).set({ deletedAt: new Date() }).where(eq(daytonaKeys.id, a.id));

  const started = await createDaytonaLifecycle().start(sessionContext(eveSessionId), undefined, ARTIFACT);
  try {
    expect(started.state.keyId).toBe(b.id);
    expect(await sandboxRow(session!.id)).toMatchObject({ daytonaKeyId: b.id, state: "started" });
    expect((await fakeSandbox.counters()).created).toBe(2);
    expect((await fakeSandbox.counters()).deleted).toBe(1);

    expect(await deleteKey(a.id)).toEqual({ remaining: 0 });
    expect((await keyRow(a.id)).apiKeyEncrypted).toBe("deleted");
  } finally {
    await started.connection.close?.();
  }
}, 60_000);

test("401 при восстановлении по имени переводит выбор на другой ключ", async () => {
  const a = await createDaytonaKey({ label: "A", apiKey: KEY_A });
  const b = await createDaytonaKey({ label: "B", apiKey: KEY_B });
  await fakeSandbox.setQuota(KEY_A, ONE_SLOT);
  await fakeSandbox.setQuota(KEY_B, ONE_SLOT);
  const user = await createUser();
  const eveSessionId = randomUUID();
  const [session] = await db().insert(appSessions).values({ userId: user.id, eveSessionId }).returning();
  await db().insert(sandboxes).values({
    appSessionId: session!.id,
    daytonaKeyId: a.id,
    daytonaSandboxId: "",
    state: "starting",
    startingSince: new Date(),
    startingKind: "create",
  });
  await fakeSandbox.failNextGet("unauthorized");

  const started = await createDaytonaLifecycle().start(sessionContext(eveSessionId), undefined, ARTIFACT);
  try {
    expect(started.state.keyId).toBe(b.id);
    expect(await sandboxRow(session!.id)).toMatchObject({ daytonaKeyId: b.id, state: "started" });
    expect(await keyRow(a.id)).toMatchObject({ usage: { error: "unauthorized" } });
    expect((await fakeSandbox.counters()).created).toBe(1);
  } finally {
    await started.connection.close?.();
  }
}, 60_000);

test("десять одновременных стартов не занимают весь пул соединений", async () => {
  await createDaytonaKey({ apiKey: KEY_A });
  await fakeSandbox.setQuota(KEY_A, { cpu: 10, memoryGb: 10, diskGb: 30 });
  const user = await createUser();
  const eveSessions = Array.from({ length: 10 }, () => randomUUID());
  const rows = await db().insert(appSessions).values(
    eveSessions.map((eveSessionId) => ({ userId: user.id, eveSessionId })),
  ).returning();
  const lifecycle = createDaytonaLifecycle();
  const settled = await Promise.allSettled(
    rows.map((row) => lifecycle.start(sessionContext(row.eveSessionId!), undefined, ARTIFACT)),
  );
  const opened = settled.filter((result) => result.status === "fulfilled");
  const refused = settled.filter((result) => result.status === "rejected");
  expect(opened).toHaveLength(2);
  expect(refused).toHaveLength(8);
  for (const result of refused) {
    if (result.status !== "rejected") continue;
    expect((result.reason as StudioSandboxError).code).toBe("capacity_exhausted");
  }
  expect((await fakeSandbox.counters()).created).toBe(2);
  for (const result of opened) {
    if (result.status === "fulfilled") await result.value.connection.close?.();
  }
}, 60_000);

test("пять одновременных стартов при двух ключах дают ровно две песочницы", async () => {
  const a = await createDaytonaKey({ label: "A", apiKey: KEY_A });
  const b = await createDaytonaKey({ label: "B", apiKey: KEY_B });
  await fakeSandbox.setQuota(KEY_A, ONE_SLOT);
  await fakeSandbox.setQuota(KEY_B, ONE_SLOT);
  const user = await createUser();
  const eveSessions = Array.from({ length: 5 }, () => randomUUID());
  const rows = await db().insert(appSessions).values(
    eveSessions.map((eveSessionId) => ({ userId: user.id, eveSessionId })),
  ).returning();

  const lifecycle = createDaytonaLifecycle();
  const settled = await Promise.allSettled(
    rows.map((row) => lifecycle.start(sessionContext(row.eveSessionId!), undefined, ARTIFACT)),
  );
  const opened = settled.filter((result) => result.status === "fulfilled");
  const refused = settled.filter((result) => result.status === "rejected");
  expect(opened).toHaveLength(2);
  expect(refused).toHaveLength(3);
  for (const result of refused) {
    expect(result.status).toBe("rejected");
    if (result.status !== "rejected") continue;
    expect(result.reason).toBeInstanceOf(StudioSandboxError);
    expect((result.reason as StudioSandboxError).code).toBe("capacity_exhausted");
  }

  expect((await fakeSandbox.counters()).created).toBe(2);
  const keys = await db().select().from(sandboxes);
  expect(new Set(keys.map((row) => row.daytonaKeyId))).toEqual(new Set([a.id, b.id]));

  for (const result of opened) {
    if (result.status === "fulfilled") await result.value.connection.close?.();
  }
}, 60_000);
