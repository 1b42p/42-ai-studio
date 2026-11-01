/** Настоящий lifecycle Daytona, фиктивная только внешняя граница Daytona. */
import { eq } from "drizzle-orm";
import type { MessageStreamEvent } from "eve/client";
import { beforeEach, describe, expect, test } from "vitest";

import { daytonaKeys, sandboxes, type User } from "../../lib/db/schema";
import { appOutput } from "./support/app";
import { createSessionAs, eveClientAs, readStreamUntil, sendAndWait, waitForStoredEvents } from "./support/chat";
import { createDaytonaKey, createUser, db, resetDatabase } from "./support/db";
import { fakeSandbox } from "./support/fake-sandbox";

const SECRET = "dtn_test_secret_value";
const READ_FILE = '/tool read_file {"filePath":"/workspace/notes.txt"}';

beforeEach(async () => {
  await resetDatabase();
  await fakeSandbox.reset();
});

function toolResult(events: readonly MessageStreamEvent[], name = "read_file") {
  const results = events.filter((event) => event.type === "action.result");
  const event = results.find((event) => event.data.result.kind === "tool-result" && event.data.result.toolName === name);
  expect(event, `Нет результата ${name}: ${events.map((item) => item.type).join(", ")}`).toBeDefined();
  return event!.data;
}

function expectRead(events: readonly MessageStreamEvent[], text: string) {
  const result = toolResult(events);
  expect(result.status).toBe("completed");
  expect(result.result).toMatchObject({
    kind: "tool-result", toolName: "read_file", output: { content: expect.stringContaining(text) },
  });
}

async function sandboxRow(appSessionId: string) {
  const rows = await db().select().from(sandboxes).where(eq(sandboxes.appSessionId, appSessionId));
  expect(rows).toHaveLength(1);
  return rows[0];
}

async function expectNoSecret(user: User, id: string, events: readonly MessageStreamEvent[]) {
  expect(JSON.stringify(events)).not.toContain(SECRET);
  const stored = await waitForStoredEvents(user, id, (items) => items.some((item) => item.payload.type === "session.waiting"));
  expect(JSON.stringify(stored)).not.toContain(SECRET);
  expect(appOutput()).not.toContain(SECRET);
}

describe("песочница сессии", () => {
  test("read_file создаёт одну песочницу, сохраняет файлы между ходами и восстанавливает её после автостопа", async () => {
    const key = await createDaytonaKey();
    const user = await createUser();
    const { id } = await createSessionAs(user);
    await fakeSandbox.seed(id, { "/workspace/notes.txt": "Файл из начального состояния\n" });

    const first = await sendAndWait(user, id, READ_FILE);
    expectRead(first, "Файл из начального состояния");
    const original = await sandboxRow(id);
    expect(original).toMatchObject({ state: "started", daytonaKeyId: key.id });
    expect((await fakeSandbox.counters()).created).toBe(1);

    // Меняем живой файл, чтобы повторное чтение не могло пройти по старому результату.
    await fakeSandbox.files.write(id, "/workspace/notes.txt", "Изменение в живой песочнице\n");
    expectRead(await sendAndWait(user, id, READ_FILE), "Изменение в живой песочнице");
    expect((await sandboxRow(id)).daytonaSandboxId).toBe(original.daytonaSandboxId);
    expect((await fakeSandbox.counters()).created).toBe(1);

    await fakeSandbox.stop(id);
    const stopped = await fakeSandbox.counters();
    expectRead(await sendAndWait(user, id, READ_FILE), "Изменение в живой песочнице");
    expect(await sandboxRow(id)).toMatchObject({ state: "started", daytonaSandboxId: original.daytonaSandboxId });
    expect(await fakeSandbox.counters()).toMatchObject({ created: 1, started: stopped.started + 1 });

    await db().update(daytonaKeys).set({ enabled: false }).where(eq(daytonaKeys.id, key.id));
    expectRead(await sendAndWait(user, id, READ_FILE), "Изменение в живой песочнице");
    expect((await fakeSandbox.counters()).created).toBe(1);

    const replacement = await createDaytonaKey({ label: "второй", apiKey: "dtn_second_test_secret" });
    await db().update(daytonaKeys).set({ deletedAt: new Date() }).where(eq(daytonaKeys.id, key.id));
    const renewed = await sendAndWait(user, id, READ_FILE);
    expect(toolResult(renewed).status).toBe("failed");
    expect(JSON.stringify(toolResult(renewed))).not.toContain("Изменение в живой песочнице");
    const fresh = await sandboxRow(id);
    expect(fresh.daytonaSandboxId).not.toBe(original.daytonaSandboxId);
    expect(fresh).toMatchObject({ daytonaKeyId: replacement.id, state: "started" });
    expect((await fakeSandbox.counters()).created).toBe(2);
    expect(await fakeSandbox.files.read(id, "/workspace/notes.txt")).toBeNull();
    await expectNoSecret(user, id, renewed);
  }, 90_000);

  test("без включённого неудалённого ключа инструмент объясняет, что нужно обратиться к оператору", async () => {
    await createDaytonaKey({ enabled: false });
    await createDaytonaKey({ deletedAt: new Date() });
    const user = await createUser();
    const { id } = await createSessionAs(user);
    const events = await sendAndWait(user, id, READ_FILE);
    const result = toolResult(events);
    expect(result.status).toBe("failed");
    expect(JSON.stringify(result)).toContain("no_daytona_key: Песочница недоступна: не настроен ключ Daytona. Сообщите оператору сервиса.");
    expect((await fakeSandbox.counters()).created).toBe(0);
    await expectNoSecret(user, id, events);
  });

  test.each([
    ["error", "sandbox_create_failed: Не удалось создать песочницу. Попробуйте ещё раз чуть позже."],
    ["build_failed", "sandbox_create_failed: Не удалось создать песочницу. Попробуйте ещё раз чуть позже."],
    ["unavailable", "daytona_unavailable: Daytona сейчас недоступна. Попробуйте позже."],
  ] as const)("ошибка Daytona %s безопасна для чата и журнала; повтор создаёт песочницу", async (kind, message) => {
    await createDaytonaKey();
    const user = await createUser();
    const { id } = await createSessionAs(user);
    await fakeSandbox.seed(id, { "/workspace/notes.txt": "Повтор после отказа\n" });
    await fakeSandbox.failNextCreate(kind);

    const events = await sendAndWait(user, id, READ_FILE);
    expect(toolResult(events).status).toBe("failed");
    expect(JSON.stringify(toolResult(events))).toContain(message);
    if (kind === "build_failed") {
      expect((await fakeSandbox.counters()).deleted).toBe(1);
      expect(await fakeSandbox.files.list(id, "/workspace")).toEqual([]);
    }
    await expectNoSecret(user, id, events);
    expectRead(await sendAndWait(user, id, READ_FILE), "Повтор после отказа");
    expect((await sandboxRow(id)).state).toBe("started");
    expect(appOutput()).not.toContain(SECRET);
  }, 60_000);
});

test("оператор видит bash и read_file, но не write_file", async () => {
  const operator = await createUser({ isOperator: true });
  const { id } = await createSessionAs(operator);
  const client = await eveClientAs(operator, id);
  const info = await client.info();
  const names = info.tools.static.map((tool) => tool.name);
  expect(names).toEqual(expect.arrayContaining(["bash", "read_file"]));
  expect(names).not.toContain("write_file");
  expect(JSON.stringify(info)).not.toContain(SECRET);
});

test("bash возвращает штатный stub eve, не исполняя служебный скрипт в фиктивной песочнице", async () => {
  const user = await createUser();
  const { id } = await createSessionAs(user);
  const client = await eveClientAs(user, id);
  const output = { status: "completed", exitCode: 0, stdout: "Привет из команды\n", stderr: "", truncated: false };
  const created = await client.sessions.create({
    message: '/tool bash {"command":"printf привет"}',
    stubs: [{ id: "bash-success", tool: "bash", outcome: { response: output } }],
  });
  const events = await readStreamUntil(created.response, "session.waiting");
  expect(toolResult(events, "bash")).toMatchObject({ status: "completed", result: { output } });
  expect((await fakeSandbox.counters()).created).toBe(0);
});
