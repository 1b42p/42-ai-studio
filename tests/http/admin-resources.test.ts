import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, test } from "vitest";

import type { AdminSandboxesResponse, AdminUsageResponse } from "../../lib/admin/resource-types";
import { openSandboxSeconds, usageDates } from "../../lib/admin/usage";
import { daytonaSandboxName } from "../../agent/lib/daytona-backend";
import { loadConfig } from "../../lib/config";
import { getSqlClient } from "../../lib/db/client";
import { appSessions, bashJobs, pendingSandboxUsage, queueEntries, sandboxes, sessionEvents, usageRecords, type User } from "../../lib/db/schema";
import { getFakeBackend } from "../../lib/sandbox/fake";
import { fetchApp } from "./support/app";
import { loginAs } from "./support/auth";
import { createSessionAs, sendAndWait, waitForStoredEvents } from "./support/chat";
import { createDaytonaKey, createUser, db, resetDatabase } from "./support/db";
import { fakeSandbox } from "./support/fake-sandbox";

beforeEach(async () => {
  await resetDatabase();
  await fakeSandbox.reset();
});

async function api(path: string, user?: User) {
  return fetchApp(path, { headers: user ? { cookie: await loginAs(user) } : {} });
}

async function usage(operator: User, query = ""): Promise<AdminUsageResponse> {
  const response = await api(`/api/admin/usage${query}`, operator);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  return response.json();
}

async function record(user: User, kind: string, amount: number, at: string) {
  await getSqlClient()`insert into usage_records (user_id, kind, amount, source_key, recorded_at)
    values (${user.id}, ${kind}, ${amount}, ${randomUUID()}, ${at}::timestamptz)`;
}

describe("отчёты ресурсов: доступ и период", () => {
  test("оба маршрута доступны только действующему оператору и не кэшируются", async () => {
    const ordinary = await createUser();
    const operator = await createUser({ isOperator: true });
    const blocked = await createUser({ isOperator: true, isBlocked: true });
    for (const path of ["/api/admin/sandboxes", "/api/admin/usage"]) {
      expect((await api(path)).status).toBe(401);
      expect((await api(path, ordinary)).status).toBe(403);
      expect((await api(path, blocked)).status).toBe(403);
      const response = await api(path, operator);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
  });

  test("отвергает неверные даты, длину периода, пояс и UUID", async () => {
    const operator = await createUser({ isOperator: true });
    for (const query of [
      "from=", "to=", "from=2026-02-30", "from=0000-01-01", "from=2026-1-01",
      "from=2026-01-02&to=2026-01-01",
      "from=2025-01-01&to=2026-01-02", "tz=Not/AZone", "tz=", "userId=no", "userId=",
      "page=0", "page=-1", "page=1.5", "page=1e2", "page=", "page=1000000000",
      "page=1%3Bselect", "metric=money", "metric=", `q=${"я".repeat(65)}`,
    ]) {
      const response = await api(`/api/admin/usage?${query}`, operator);
      expect(response.status, query).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "invalid_request" } });
    }
    const maximum = await usage(operator, "?from=2025-01-01&to=2026-01-01");
    expect(maximum.byDay).toHaveLength(366);
    const today = await usage(operator, "?from=2026-01-01&to=2026-01-01");
    expect(today.byDay).toHaveLength(1);
    const defaults = await usage(operator, "?tz=Pacific/Kiritimati");
    const [clock] = await getSqlClient()`select to_char(now() at time zone 'Pacific/Kiritimati', 'YYYY-MM-DD') as today`;
    expect(defaults.period.to).toBe(clock.today);
    expect(defaults.byDay).toHaveLength(7);
  });
});

describe("расход по дням и пользователям", () => {
  test("полный отчёт включает больше ста отложенных квитанций без дублей доставленного расхода", async () => {
    const operator = await createUser({ isOperator: true });
    const user = await createUser();
    const date = new Date("2026-01-02T12:00:00Z");
    const receipts = Array.from({ length: 125 }, () => ({
      userId: user.id, sourceKey: randomUUID(), amount: 60, recordedAt: date,
    }));
    await db().insert(pendingSandboxUsage).values(receipts);
    await db().insert(usageRecords).values({
      ...receipts[0], kind: "sandbox_seconds",
    });
    const report = await usage(operator, "?from=2026-01-01&to=2026-01-03");
    expect(report.totals.sandboxSeconds).toBe(7500);
    expect(report.byUser[0]).toMatchObject({ user: { id: user.id }, sandboxSeconds: 7500 });
    expect(report.byDay.map((day) => day.sandboxSeconds)).toEqual([0, 7500, 0]);
  });

  test("границы суток зависят от пояса; пустые дни заполнены, фильтр и удаление применяются ко всем итогам", async () => {
    const operator = await createUser({ isOperator: true });
    const alice = await createUser({ name: "Алиса" });
    const bob = await createUser({ name: "Борис" });
    const charlie = await createUser({ name: "Чарли" });
    for (let day = 1; day <= 10; day += 1) {
      const date = `2026-01-${String(day).padStart(2, "0")}T12:00:00Z`;
      await record(alice, "sandbox_seconds", 100, date);
      await record(bob, "sandbox_seconds", 200, date);
    }
    await record(alice, "model_input_tokens", 100, "2026-01-01T23:30:00Z");
    await record(alice, "model_input_tokens", 200, "2026-01-02T00:30:00Z");
    await record(charlie, "model_output_tokens", 50, "2026-01-02T00:30:00Z");
    // Конец периода исключает ровно полночь следующего дня.
    await record(bob, "sandbox_seconds", 999, "2026-01-11T00:00:00Z");
    const query = "?from=2026-01-01&to=2026-01-10";
    const utc = await usage(operator, query);
    expect(utc.totals).toEqual({
      sandboxSeconds: 3000, inputTokens: 300, outputTokens: 50, openSandboxSeconds: 0,
    });
    expect(utc.byDay).toHaveLength(10);
    expect(utc.byDay[0]).toEqual({
      date: "2026-01-01", sandboxSeconds: 300, inputTokens: 100, outputTokens: 0,
    });
    expect(utc.byDay[1]).toMatchObject({ date: "2026-01-02", inputTokens: 200, outputTokens: 50 });
    expect(utc.byUser.map((row) => row.user.id)).toEqual([bob.id, alice.id, charlie.id]);
    expect(utc.othersCount).toBe(0);
    const tokyo = await usage(operator, `${query}&tz=Asia/Tokyo`);
    expect(tokyo.byDay[0]).toMatchObject({ inputTokens: 0 });
    expect(tokyo.byDay[1]).toMatchObject({ inputTokens: 300, outputTokens: 50 });

    const filtered = await usage(operator, `${query}&userId=${alice.id}`);
    expect(filtered.byUser).toHaveLength(1);
    expect(filtered.byUser[0].user).toEqual({ id: alice.id, name: "Алиса", username: null });
    expect(filtered.totals).toEqual({
      sandboxSeconds: 1000, inputTokens: 300, outputTokens: 0, openSandboxSeconds: 0,
    });
    const empty = await usage(operator, `?from=2026-02-01&to=2026-02-03&userId=${alice.id}`);
    expect(empty.byUser).toEqual([]);
    expect(empty.byDay).toEqual([
      { date: "2026-02-01", sandboxSeconds: 0, inputTokens: 0, outputTokens: 0 },
      { date: "2026-02-02", sandboxSeconds: 0, inputTokens: 0, outputTokens: 0 },
      { date: "2026-02-03", sandboxSeconds: 0, inputTokens: 0, outputTokens: 0 },
    ]);
    const deletion = await fetchApp(`/api/admin/users/${alice.id}`, {
      method: "DELETE", headers: { cookie: await loginAs(operator) },
    });
    expect(deletion.status).toBe(204);
    expect((await usage(operator, query)).totals).toEqual({
      sandboxSeconds: 2000, inputTokens: 0, outputTokens: 50, openSandboxSeconds: 0,
    });
  });

  test("переход летнего времени использует местные полуночи, а не 24 часа", async () => {
    const operator = await createUser({ isOperator: true });
    const user = await createUser();
    await record(user, "model_input_tokens", 10, "2026-03-08T05:00:00Z");
    await record(user, "model_input_tokens", 20, "2026-03-09T03:59:59Z");
    await record(user, "model_input_tokens", 100, "2026-03-09T04:00:00Z");
    const report = await usage(operator, "?from=2026-03-08&to=2026-03-08&tz=America/New_York");
    expect(report.totals.inputTokens).toBe(30);
    expect(report.byDay).toEqual([
      { date: "2026-03-08", sandboxSeconds: 0, inputTokens: 30, outputTokens: 0 },
    ]);
  });

  test("серверные страницы доступны целиком и не обрезают общие итоги", async () => {
    const operator = await createUser({ isOperator: true });
    await getSqlClient()`
      with inserted as (
        insert into users (telegram_id, name)
        select 100000000 + n, 'Пользователь ' || n from generate_series(1, 102) n
        returning id, telegram_id
      )
      insert into usage_records (user_id, kind, amount, source_key, recorded_at)
      select id, 'sandbox_seconds', telegram_id - 100000000, id::text, '2026-01-05T12:00:00Z'::timestamptz
      from inserted`;
    const report = await usage(operator, "?from=2026-01-01&to=2026-01-10");
    expect(report.byUser).toHaveLength(100);
    expect(report.othersCount).toBe(2);
    expect(report.totals.sandboxSeconds).toBe(5253);
    expect(report.byUser[0].sandboxSeconds).toBe(102);
    expect(report.byUser[99].sandboxSeconds).toBe(3);
    expect(report.usersPage).toEqual({ page: 1, pageSize: 100, total: 102 });
    const second = await usage(operator, "?from=2026-01-01&to=2026-01-10&page=2");
    expect(second.byUser.map((row) => row.sandboxSeconds)).toEqual([2, 1]);
    expect(second.usersPage).toEqual({ page: 2, pageSize: 100, total: 102 });
    expect(second.othersCount).toBe(0);
    expect(second.totals).toEqual(report.totals);
    expect(second.byDay).toEqual(report.byDay);
    expect(new Set([...report.byUser, ...second.byUser].map((row) => row.user.id)).size).toBe(102);
    const beyond = await usage(operator, "?from=2026-01-01&to=2026-01-10&page=999999999");
    expect(beyond.byUser).toEqual(second.byUser);
    expect(beyond.usersPage.page).toBe(2);
    // Лидер по токенам находится за границей первой страницы времени.
    const last = second.byUser[1].user;
    await getSqlClient()`insert into usage_records (user_id, kind, amount, source_key, recorded_at)
      values (${last.id}, 'model_output_tokens', 999, ${randomUUID()}, '2026-01-05T12:00:00Z')`;
    const tokens = await usage(operator, "?from=2026-01-01&to=2026-01-10&metric=tokens");
    expect(tokens.byUser[0].user.id).toBe(last.id);
    expect(tokens.byUser[0].outputTokens).toBe(999);
    const tiedIds = tokens.byUser.slice(1).map((row) => row.user.id);
    expect(tiedIds).toEqual([...tiedIds].sort());
    const tokens2 = await usage(operator, "?from=2026-01-01&to=2026-01-10&metric=tokens&page=2");
    expect(new Set([...tokens.byUser, ...tokens2.byUser].map((row) => row.user.id)).size).toBe(102);
  });

  test("поиск имени, @username и Telegram ID фильтрует только список и сохраняет userId/период/tz", async () => {
    const operator = await createUser({ isOperator: true });
    const alice = await createUser({ name: "АЛИСА", username: "Alice_100" });
    const bob = await createUser({ name: "Борис" });
    await record(alice, "model_input_tokens", 100, "2026-01-01T23:30:00Z");
    await record(bob, "sandbox_seconds", 50, "2026-01-01T23:30:00Z");
    await record(alice, "model_input_tokens", 999, "2026-01-02T23:30:00Z");
    const query = "?from=2026-01-02&to=2026-01-02&tz=Asia/Tokyo";
    const report = await usage(operator, query);
    for (const q of ["алиса", "@ALICE_100", String(alice.telegramId)]) {
      const filtered = await usage(operator, `${query}&q=${encodeURIComponent(q)}&page=2&metric=tokens`);
      expect(filtered.byUser.map((row) => row.user.id)).toEqual([alice.id]);
      expect(filtered.byUser[0].inputTokens).toBe(100);
      expect(filtered.usersPage).toEqual({ page: 1, pageSize: 100, total: 1 });
      expect(filtered.totals).toEqual(report.totals);
      expect(filtered.byDay).toEqual(report.byDay);
      expect(filtered.period).toEqual(report.period);
    }
    for (const q of ["%", "' OR true --", "несуществующий"]) {
      const empty = await usage(operator, `${query}&q=${encodeURIComponent(q)}`);
      expect(empty.byUser).toEqual([]);
      expect(empty.usersPage).toEqual({ page: 1, pageSize: 100, total: 0 });
      expect(empty.totals).toEqual(report.totals);
    }
    const underscore = await usage(operator, `${query}&q=_`);
    expect(underscore.byUser.map((row) => row.user.id)).toEqual([alice.id]);
    const one = await usage(operator, `${query}&userId=${alice.id}&q=Борис`);
    expect(one.byUser).toEqual([]);
    expect(one.totals).toEqual({
      sandboxSeconds: 0, openSandboxSeconds: 0, inputTokens: 100, outputTokens: 0,
    });
  });
});

async function seedMachine(
  user: User,
  keyId: string,
  options: { runningSince?: Date; lastActiveAt?: Date; state?: "started" | "stopped" | "archived" } = {},
) {
  const session = await createSessionAs(user);
  const eveId = `admin-resources-${randomUUID()}`;
  await db().update(appSessions).set({
    eveSessionId: eveId, title: "СекретноеНазваниеНельзяПоказать",
  }).where(eq(appSessions.id, session.id));
  const machine = await getFakeBackend(
    loadConfig().fakeSandboxDir!, "dtn_test_secret_value", { cpu: 2, memoryGb: 4, diskGb: 8 },
  ).create({ name: daytonaSandboxName(eveId), appSessionId: session.id });
  if (options.state === "stopped") await machine.stop();
  if (options.state === "archived") await machine.archive();
  const lastActiveAt = options.lastActiveAt ?? new Date();
  await fakeSandbox.setTimes(session.id, { lastActivityAt: lastActiveAt.getTime() });
  await db().insert(sandboxes).values({
    appSessionId: session.id, daytonaKeyId: keyId, daytonaSandboxId: machine.id,
    state: options.state ?? "started",
    runningSince: options.state && options.state !== "started" ? null :
      options.runningSince ?? new Date(Date.now() - 60_000),
    lastActiveAt, daytonaActivityAt: lastActiveAt,
  });
  return session;
}

async function sandboxReport(operator: User): Promise<AdminSandboxesResponse> {
  const response = await api("/api/admin/sandboxes", operator);
  expect(response.status).toBe(200);
  return response.json();
}

describe("песочницы и открытые интервалы", () => {
  test("десять одновременных отчётов читают busy на своих соединениях без истощения пула", async () => {
    const operator = await createUser({ isOperator: true });
    const user = await createUser();
    const key = await createDaytonaKey();
    const session = await seedMachine(user, key.id, { runningSince: new Date(Date.now() - 120_000) });
    await db().insert(sessionEvents).values({
      appSessionId: session.id, seq: 0, payload: { type: "session.waiting", data: {} },
    });
    // Проходим все чтения общего helper, включая завершающую проверку bash_jobs.
    await db().insert(bashJobs).values({
      appSessionId: session.id, jobId: "deadbeef", status: "running",
    });
    await record(user, "sandbox_seconds", 42, new Date().toISOString());
    const cookie = await loginAs(operator);
    // Прогреваем маршрут и завершаем сверку до установки барьера.
    await usage(operator);
    const pending: Promise<AdminUsageResponse>[] = [];
    try {
      await getSqlClient().begin(async (barrier) => {
        await barrier`lock table sandbox_workers in access exclusive mode`;
        for (let index = 0; index < 12; index += 1) {
          const report = fetchApp("/api/admin/usage", {
            headers: { cookie }, signal: AbortSignal.timeout(20_000),
          }).then(async (response) => {
            expect(response.status).toBe(200);
            expect(response.headers.get("cache-control")).toBe("no-store");
            return response.json() as Promise<AdminUsageResponse>;
          });
          // Обработчик установлен до ожидания барьера: нет unhandled rejection
          // при таймауте или падении самого утверждения.
          void report.catch(() => {});
          pending.push(report);
        }
        // Отдельный процесс теста наблюдает пул приложения. Все десять
        // транзакций должны дойти до первого SELECT helper на своих соединениях.
        // При старой ошибке они удержат BEGIN, а SELECT навсегда останется в очереди.
        await expect.poll(async () => {
          const [row] = await getSqlClient()<{ count: string }[]>`
            select count(*)::text as count from pg_stat_activity
            where datname = current_database() and pid <> pg_backend_pid()
              and state = 'active' and wait_event_type = 'Lock'
              and query like '%sandbox_workers%'
              and xact_start is not null`;
          return Number(row.count);
        }, { timeout: 10_000, interval: 50 }).toBeGreaterThanOrEqual(10);
        // COMMIT снимает барьер: дальнейшие чтения не требуют свободного
        // соединения, а два ожидающих запроса получают освободившиеся места.
      });
      const reports = await Promise.all(pending);
      expect(reports).toHaveLength(12);
      for (const report of reports) {
        expect(report.totals.sandboxSeconds).toBe(42);
        expect(report.totals.openSandboxSeconds).toBeGreaterThanOrEqual(120);
        expect(report.byUser[0].openSandboxSeconds).toBe(report.totals.openSandboxSeconds);
        expect(report.usersPage.total).toBe(1);
      }
      expect((await usage(operator)).totals.sandboxSeconds).toBe(42);
    } finally {
      await Promise.allSettled(pending);
    }
  });

  test("идущий настоящий ход /slow виден оператору как занятый", async () => {
    const operator = await createUser({ isOperator: true });
    const user = await createUser();
    await createDaytonaKey();
    const session = await createSessionAs(user);
    await fakeSandbox.seed(session.id, { "/workspace/notes.txt": "ЛичныйТекстНельзяПоказать" });
    await sendAndWait(user, session.id, '/tool read_file {"filePath":"/workspace/notes.txt"}');
    const pending = sendAndWait(user, session.id, "/slow 20 СекретМедленногоХодаНельзяПоказать");
    // Сразу устанавливаем обработчик, чтобы отменённый поток не стал unhandled rejection.
    void pending.catch(() => {});
    try {
      await waitForStoredEvents(user, session.id, (events) =>
        events.filter((event) => event.payload.type === "turn.started").length >= 2,
      );
      const report = await sandboxReport(operator);
      expect(report.running.find((row) => row.appSessionId === session.id)?.busy).toBe(true);
      expect(JSON.stringify(report)).not.toContain("НельзяПоказать");
    } finally {
      const [row] = await db().select().from(appSessions).where(eq(appSessions.id, session.id));
      if (row?.eveSessionId) {
        await fetchApp(`/eve/v1/session/${row.eveSessionId}/cancel`, {
          method: "POST", headers: { cookie: await loginAs(user) },
        });
      }
      await Promise.allSettled([pending]);
    }
  });

  test("занятость видна по событиям и БД заданий, без toolbox и продления активности; приватные тексты скрыты", async () => {
    const operator = await createUser({ isOperator: true });
    const user = await createUser({ username: "resource_user" });
    const key = await createDaytonaKey({ label: "Метка ключа" });
    await fakeSandbox.setQuota("dtn_test_secret_value", { cpu: 30, memoryGb: 60, diskGb: 120 });
    const active = await seedMachine(user, key.id, { runningSince: new Date(Date.now() - 120_000) });
    const background = await seedMachine(user, key.id);
    const idle = await seedMachine(user, key.id);
    await seedMachine(user, key.id, { state: "stopped" });
    await seedMachine(user, key.id, { state: "archived" });
    await db().insert(sessionEvents).values([
      { appSessionId: active.id, seq: 0, payload: {
        type: "turn.started", data: { turnId: "active", text: "СекретноеСообщениеНельзяПоказать" },
      } },
      { appSessionId: background.id, seq: 0, payload: { type: "session.waiting", data: {} } },
      { appSessionId: idle.id, seq: 0, payload: { type: "turn.waiting", data: { on: "input" } } },
    ]);
    await db().insert(bashJobs).values({
      appSessionId: background.id, jobId: "deadbeef", status: "running",
      stdoutTail: "СекретныйВыводКомандыНельзяПоказать",
    });
    const before = await fakeSandbox.counters();
    const report = await sandboxReport(operator);
    expect(report.counts).toEqual({ running: 3, stopped: 1, archived: 1, queued: 0 });
    expect(report.running.map((row) => row.appSessionId)[0]).toBe(active.id);
    expect(report.running.find((row) => row.appSessionId === active.id)).toMatchObject({
      sessionRef: active.id.slice(0, 8), busy: true, keyLabel: "Метка ключа",
      user: { id: user.id, name: user.name, username: "resource_user" },
    });
    expect(report.running.find((row) => row.appSessionId === background.id)?.busy).toBe(true);
    expect(report.running.find((row) => row.appSessionId === idle.id)?.busy).toBe(false);
    expect(JSON.stringify(report)).not.toContain("НельзяПоказать");
    expect((await fakeSandbox.counters()).refreshActivity).toBe(before.refreshActivity);
    expect((await fakeSandbox.calls(background.id)).filter((call) => call.op === "readJobDirectory")).toEqual([]);
    const usageCalls = await fakeSandbox.usageCalls();
    await usage(operator);
    const again = await sandboxReport(operator);
    expect(again.running).toHaveLength(3);
    expect((await fakeSandbox.counters()).refreshActivity).toBe(before.refreshActivity);
    expect(await fakeSandbox.usageCalls()).toBe(usageCalls);
  });

  test("открытое время отдельно от закрытого; простой ограничен автостопом, активный ход не ограничен", async () => {
    const operator = await createUser({ isOperator: true });
    const user = await createUser();
    const key = await createDaytonaKey();
    await fakeSandbox.setQuota("dtn_test_secret_value", { cpu: 30, memoryGb: 60, diskGb: 120 });
    const now = Date.now();
    const idleMs = loadConfig().sandboxIdleStopMinutes * 60_000;
    const idle = await seedMachine(user, key.id, {
      runningSince: new Date(now - idleMs - 10 * 60_000),
      lastActiveAt: new Date(now - 2 * idleMs - 5 * 60_000),
    });
    const active = await seedMachine(user, key.id, {
      runningSince: new Date(now - idleMs - 10 * 60_000),
      lastActiveAt: new Date(now - idleMs - 5 * 60_000),
    });
    await db().insert(sessionEvents).values([
      { appSessionId: idle.id, seq: 0, payload: { type: "session.waiting", data: {} } },
      { appSessionId: active.id, seq: 0, payload: { type: "turn.started", data: { turnId: "busy" } } },
    ]);
    // Собственная запись расхода находится внутри запрошенного периода.
    await record(user, "sandbox_seconds", 42, new Date(now).toISOString());
    const report = await usage(operator, `?userId=${user.id}`);
    expect(report.totals.sandboxSeconds).toBe(42);
    expect(report.totals.openSandboxSeconds).toBeGreaterThanOrEqual(idleMs / 1000 + 900);
    expect(report.totals.openSandboxSeconds).toBeLessThan(idleMs / 1000 + 910);
    expect(report.byUser[0].openSandboxSeconds).toBe(report.totals.openSandboxSeconds);
    expect(report.byDay.reduce((sum, day) => sum + day.sandboxSeconds, 0)).toBe(42);
    const historical = await usage(operator, "?from=2000-01-01&to=2000-01-01");
    expect(historical.totals.openSandboxSeconds).toBe(0);
  });

  test("пользователь только с открытым временем участвует в сортировке и поиске, но не в дневном расходе", async () => {
    const operator = await createUser({ isOperator: true });
    const running = await createUser({ name: "Открытая песочница" });
    const closed = await createUser({ name: "Закрытый расход" });
    const key = await createDaytonaKey();
    const session = await seedMachine(running, key.id, { runningSince: new Date(Date.now() - 1_200_000) });
    await db().insert(sessionEvents).values({
      appSessionId: session.id, seq: 0, payload: { type: "turn.started", data: { turnId: "busy" } },
    });
    await record(closed, "sandbox_seconds", 600, new Date().toISOString());
    await record(closed, "model_output_tokens", 42, new Date().toISOString());
    const report = await usage(operator);
    expect(report.byUser.map((row) => row.user.id)).toEqual([running.id, closed.id]);
    expect(report.byUser[0].sandboxSeconds).toBe(0);
    expect(report.byUser[0].openSandboxSeconds).toBeGreaterThanOrEqual(1200);
    expect(report.byDay.reduce((sum, day) => sum + day.sandboxSeconds, 0)).toBe(600);
    const tokens = await usage(operator, "?metric=tokens");
    expect(tokens.byUser.map((row) => row.user.id)).toEqual([closed.id, running.id]);
    const searched = await usage(operator, "?q=Открытая");
    expect(searched.byUser.map((row) => row.user.id)).toEqual([running.id]);
    expect(searched.totals.sandboxSeconds).toBe(report.totals.sandboxSeconds);
    expect(searched.totals.outputTokens).toBe(42);
    expect(searched.byDay).toEqual(report.byDay);
  });

  test("очередь имеет тот же порядок и позиции, что у владельца, исключает протухшие и удалённые сессии", async () => {
    const operator = await createUser({ isOperator: true });
    const firstUser = await createUser();
    const secondUser = await createUser();
    const key = await createDaytonaKey({ label: "Ожидаемый ключ" });
    const first = await createSessionAs(firstUser);
    const second = await createSessionAs(secondUser);
    const stale = await createSessionAs(firstUser);
    const removed = await createSessionAs(firstUser);
    const now = Date.now();
    await db().update(appSessions).set({ deletedAt: new Date() }).where(eq(appSessions.id, removed.id));
    await db().insert(queueEntries).values([
      { appSessionId: second.id, userId: secondUser.id, need: "wake", reason: "own_session_busy",
        daytonaKeyId: key.id, enqueuedAt: new Date(now - 30_000) },
      { appSessionId: first.id, userId: firstUser.id, need: "create", reason: "capacity",
        enqueuedAt: new Date(now - 60_000) },
      { appSessionId: stale.id, userId: firstUser.id, need: "restore",
        heartbeatAt: new Date(now - 61_000), enqueuedAt: new Date(now - 90_000) },
      { appSessionId: removed.id, userId: firstUser.id, need: "create", enqueuedAt: new Date(now - 120_000) },
    ]);
    const report = await sandboxReport(operator);
    expect(report.counts.queued).toBe(2);
    expect(report.queue.map((row) => row.appSessionId)).toEqual([first.id, second.id]);
    expect(report.queue[0]).toMatchObject({ position: 1, need: "create", reason: "capacity", keyLabel: null });
    expect(report.queue[0].waitingSeconds).toBeGreaterThanOrEqual(60);
    expect(report.queue[1]).toMatchObject({
      position: 2, need: "wake", reason: "own_session_busy", keyLabel: "Ожидаемый ключ",
    });
    const owner = await api(`/api/sessions/${second.id}/sandbox`, secondUser);
    expect(await owner.json()).toEqual({
      state: "queued", queue: { position: report.queue[1].position, total: 2, reason: "own_session_busy" },
    });
    await db().delete(queueEntries).where(eq(queueEntries.appSessionId, first.id));
    const updated = await sandboxReport(operator);
    expect(updated.queue).toHaveLength(1);
    expect(updated.queue[0].position).toBe(1);
  });

  test("повторный отчёт замечает автостоп Daytona, не пробуждая машину", async () => {
    const operator = await createUser({ isOperator: true });
    const user = await createUser();
    const key = await createDaytonaKey();
    const session = await seedMachine(user, key.id);
    const before = await fakeSandbox.counters();
    expect((await sandboxReport(operator)).counts.running).toBe(1);
    await fakeSandbox.stop(session.id);
    await expect.poll(async () => (await sandboxReport(operator)).counts, {
      timeout: 15_000, interval: 250,
    }).toEqual({ running: 0, stopped: 1, archived: 0, queued: 0 });
    const counters = await fakeSandbox.counters();
    expect(counters.started).toBe(before.started);
    expect(counters.refreshActivity).toBe(before.refreshActivity);
  });
});

describe("чистый расчёт открытой части", () => {
  const base = {
    runningSince: new Date("2026-03-08T05:00:00Z"),
    lastActiveAt: new Date("2026-03-08T06:00:00Z"),
    busy: false, idleMinutes: 15,
    from: new Date("2026-03-08T05:30:00Z"),
    until: new Date("2026-03-08T07:00:00Z"),
    now: new Date("2026-03-08T08:00:00Z"),
  };
  test("обрезает начало периодом и конец автостопом", () => {
    expect(openSandboxSeconds(base)).toBe(2700);
  });
  test("занятый ход ограничивается концом периода, отсутствие интервала даёт ноль", () => {
    expect(openSandboxSeconds({ ...base, busy: true })).toBe(5400);
    expect(openSandboxSeconds({ ...base, runningSince: null })).toBe(0);
    expect(openSandboxSeconds({ ...base, from: new Date("2026-03-09T00:00:00Z") })).toBe(0);
    expect(openSandboxSeconds({ ...base, now: new Date("2026-03-08T06:00:00Z") })).toBe(1800);
  });
  test("календарная последовательность содержит 29 февраля високосного года", () => {
    expect(usageDates("2024-02-28", "2024-03-01")).toEqual(["2024-02-28", "2024-02-29", "2024-03-01"]);
  });
});
