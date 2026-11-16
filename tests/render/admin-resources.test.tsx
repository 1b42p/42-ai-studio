import { act } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { page } from "vitest/browser";

import { AdminShell } from "@/components/studio/admin/admin-shell";
import { adminSections } from "@/components/studio/admin/sections";
import { AdminSandboxesPanel } from "@/components/studio/admin/resources/admin-sandboxes-panel";
import { AdminUsagePanel } from "@/components/studio/admin/resources/admin-usage-panel";
import {
  fetchAdminSandboxes, fetchAdminUsage, usagePeriod, type UsageQuery,
} from "@/components/studio/admin/resources/resource-data";
import { validUsageDate, validUsageDates } from "@/lib/admin/usage-period";
import { AppShell } from "@/components/studio/app-shell";
import { navItemsFor } from "@/components/studio/nav";
import type { AdminResourceUser, AdminSandboxesResponse, AdminUsageResponse } from "@/lib/admin/resource-types";
import { expectNoHorizontalScroll, renderOnDesktop, renderOnPhone } from "./support/render";

const NOW = new Date("2026-11-16T11:05:09Z");
const TZ = "Europe/Moscow";
const USER: AdminResourceUser = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "Иван Петров",
  username: "ivan",
};
const LONG = "я".repeat(200);
const LONG_USER = { ...USER, id: "00000000-0000-4000-8000-000000000002", name: LONG };

function sandboxes(): AdminSandboxesResponse {
  return {
    generatedAt: NOW.toISOString(),
    counts: { running: 2, stopped: 3, archived: 4, queued: 2 },
    running: [USER, LONG_USER].map((user, index) => ({
      appSessionId: `10000000-0000-4000-8000-00000000000${index}`,
      sessionRef: index === 0 ? "a1b2c3d4" : "b2c3d4e5",
      user, keyId: "key", keyLabel: "Основной",
      state: index === 0 ? "started" : "starting",
      runningSince: index === 0 ? "2026-11-16T09:00:09Z" : null,
      runningSeconds: index === 0 ? 7500 : 0,
      lastActiveAt: "2026-11-16T11:02:09Z",
      busy: index === 0,
    })),
    queue: [USER, LONG_USER].map((user, index) => ({
      position: index + 1, appSessionId: `20000000-0000-4000-8000-00000000000${index}`,
      sessionRef: index === 0 ? "c3d4e5f6" : "d4e5f6a7", user,
      need: index === 0 ? "create" : "wake",
      reason: index === 0 ? "capacity" : "own_session_busy",
      keyLabel: index === 0 ? "Основной" : null,
      enqueuedAt: "2026-11-16T11:03:00Z", waitingSeconds: 129,
    })),
  };
}

function usage(query: UsageQuery = { from: "2026-11-10", to: "2026-11-16", tz: TZ }): AdminUsageResponse {
  const days = (Date.parse(query.to) - Date.parse(query.from)) / 86_400_000 + 1;
  return {
    period: { from: query.from, to: query.to, tz: query.tz },
    totals: { sandboxSeconds: 44_640, openSandboxSeconds: 4320, inputTokens: 1_200_000, outputTokens: 123_456 },
    byDay: Array.from({ length: days }, (_, index) => {
      const day = new Date(`${query.from}T00:00:00Z`);
      day.setUTCDate(day.getUTCDate() + index);
      return { date: day.toISOString().slice(0, 10), sandboxSeconds: 3600, inputTokens: 1000, outputTokens: 100 };
    }),
    byUser: [USER, LONG_USER].map((user) => ({
      user, sandboxSeconds: 44_640, openSandboxSeconds: 4320, inputTokens: 1_200_000, outputTokens: 123_456,
    })),
    othersCount: 3,
  };
}

function shell(kind: "sandboxes" | "usage", children: React.ReactNode) {
  return (
    <AppShell navItems={navItemsFor(true)} pathname={`/admin/${kind}`}>
      <AdminShell pathname={`/admin/${kind}`} sections={adminSections}>{children}</AdminShell>
    </AppShell>
  );
}

function noMoney() {
  expect(document.body.textContent).not.toMatch(/₽|\$|баланс|стоимость/i);
}

function visibleElements(selector: string) {
  return [...document.querySelectorAll<HTMLElement>(selector)].filter((node) => node.getClientRects().length > 0);
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

for (const [label, render, phone] of [
  ["телефон 390×844", renderOnPhone, true],
  ["компьютер 1280×800", renderOnDesktop, false],
] as const) {
  test(`${label}: песочницы, все поля, состояния, причины, длинные имена`, async () => {
    await render(shell("sandboxes", <AdminSandboxesPanel
      initialData={sandboxes()} request={async () => sandboxes()} timeZone={TZ} />));
    await expect.element(page.getByText("Обновлено в 14:05:09")).toBeVisible();
    for (const title of ["Запущено", "Остановлено", "В архиве", "В очереди"]) {
      await expect.element(page.getByText(title, { exact: true })).toBeVisible();
    }
    const root = phone ? page.getByRole("list", { name: "Запущенные песочницы" })
      : page.getByRole("table", { name: "Запущенные песочницы" });
    await expect.element(root.getByText("Занята", { exact: true })).toBeVisible();
    await expect.element(root.getByText("Запускается", { exact: true })).toBeVisible();
    expect(visibleElements("[data-slot=table]").length).toBe(phone ? 0 : 2);
    expect(visibleElements("[data-slot=item-group]").length).toBe(phone ? 2 : 0);
    const text = visibleElements("[data-slot=item-group], [data-slot=table]").map((node) => node.textContent).join(" ");
    for (const value of ["a1b2c3d4", "@ivan", "Основной", "2 ч 05 мин", "3 мин. назад", "02:09", "Создание", "Пробуждение", "Нет места", "Идёт другая сессия пользователя"]) {
      expect(text).toContain(value);
    }
    await expect.element(root.getByRole("link", { name: USER.name })).toHaveAttribute("href", `/admin/users?userId=${USER.id}`);
    const long = visibleElements("[data-slot=item-title]").find((node) => node.textContent === LONG)!;
    expect(long.scrollWidth).toBeGreaterThan(long.clientWidth);
    expectNoHorizontalScroll();
    noMoney();
  });

  test(`${label}: песочницы — загрузка, ошибка, повтор и пустые состояния`, async () => {
    let resolve: ((data: AdminSandboxesResponse) => void) | undefined;
    const request = vi.fn<() => Promise<AdminSandboxesResponse>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockImplementationOnce(() => new Promise((done) => { resolve = done; }))
      .mockResolvedValue({ ...sandboxes(), running: [], queue: [] });
    await render(shell("sandboxes", <AdminSandboxesPanel request={request} timeZone={TZ} />));
    await expect.element(page.getByText("Не удалось загрузить данные")).toBeVisible();
    await page.getByRole("button", { name: "Повторить" }).click();
    await expect.element(page.getByRole("status", { name: "Загрузка данных" })).toBeVisible();
    expect(document.querySelectorAll("[data-slot=skeleton]")).toHaveLength(3);
    await act(async () => {
      resolve!({ ...sandboxes(), running: [], queue: [], counts: { running: 0, stopped: 0, archived: 0, queued: 0 } });
    });
    await expect.element(page.getByText("Запущенных песочниц нет")).toBeVisible();
    await expect.element(page.getByText("Очередь пуста")).toBeVisible();
    await page.getByRole("button", { name: "Обновить" }).click();
    expect(request).toHaveBeenCalledTimes(3);
    expectNoHorizontalScroll();
  });

  test(`${label}: расход — карточки, дневные столбцы, токены, ссылки, пояснение`, async () => {
    const request = vi.fn(async (query: UsageQuery) => usage(query));
    await render(shell("usage", <AdminUsagePanel request={request} now={NOW} timeZone={TZ} />));
    await expect.element(page.getByText("Часовой пояс: Europe/Moscow")).toBeVisible();
    await expect.poll(() => document.querySelectorAll(".recharts-bar-rectangle").length).toBe(7);
    const text = document.body.textContent!.replace(/\u00a0/g, " ");
    expect(text).toContain("12,4 ч");
    expect(text).toContain("1,2 млн");
    expect(text).toContain("123 456");
    expect(text).toContain("+ ещё идёт: 1,2 ч");
    expect(text).toContain("остановку самой Daytona по бездействию учитывает приблизительно");
    expect(text).toContain("Ещё пользователей: 3");
    expect(visibleElements("[data-slot=table]").length).toBe(phone ? 0 : 1);
    expect(visibleElements("[data-slot=item-group]").length).toBe(phone ? 1 : 0);
    // The whole phone item is a link; the desktop identity is a keyboard-accessible link.
    const links = [...document.querySelectorAll<HTMLAnchorElement>("a")].filter((node) =>
      node.getClientRects().length > 0 && node.href.includes(`/admin/usage?`) && node.textContent?.includes(USER.name));
    expect(links[0]?.getAttribute("href")).toContain(`userId=${USER.id}`);
    await page.getByRole("button", { name: "Токены", exact: true }).click();
    await expect.poll(() => document.querySelectorAll(".recharts-bar-rectangle").length).toBe(14);
    await expect.element(page.getByText("Входные", { exact: true })).toBeVisible();
    await expect.element(page.getByText("Выходные", { exact: true })).toBeVisible();
    expectNoHorizontalScroll();
    noMoney();
  });

  test(`${label}: периоды, свои даты, чип и сброс`, async () => {
    const request = vi.fn(async (query: UsageQuery) => usage(query));
    const reset = vi.fn();
    await render(shell("usage", <AdminUsagePanel
      request={request} now={NOW} timeZone={TZ} initialUser={USER} onResetFilter={reset} />));
    await expect.poll(() => request.mock.calls.length).toBe(1);
    expect(request.mock.calls[0]![0]).toEqual({ from: "2026-11-10", to: "2026-11-16", tz: TZ, userId: USER.id });
    for (const [title, from] of [
      ["Сегодня", "2026-11-16"], ["30 дней", "2026-10-18"], ["90 дней", "2026-08-19"], ["7 дней", "2026-11-10"],
    ]) {
      await page.getByRole("button", { name: title, exact: true }).click();
      await expect.poll(() => request.mock.calls.at(-1)?.[0].from).toBe(from);
      expect(request.mock.calls.at(-1)?.[0].to).toBe("2026-11-16");
    }
    await page.getByRole("button", { name: "Свой период" }).click();
    await page.getByLabelText("Начало периода").fill("2026-11-01");
    await page.getByLabelText("Конец периода").fill("2026-11-03");
    await expect.poll(() => request.mock.calls.at(-1)?.[0]).toEqual({
      from: "2026-11-01", to: "2026-11-03", tz: TZ, userId: USER.id,
    });
    await expect.poll(() => document.querySelectorAll(".recharts-bar-rectangle").length).toBe(3);
    await page.getByRole("button", { name: "Сбросить", exact: true }).click();
    expect(reset).toHaveBeenCalledTimes(1);
    await expect.element(page.getByRole("link", { name: "Профиль пользователя" }))
      .toHaveAttribute("href", `/admin/users?userId=${USER.id}`);
    expectNoHorizontalScroll();
  });

  test(`${label}: расход — ошибка и повтор, пустые дни, неверный период`, async () => {
    const request = vi.fn<(query: UsageQuery) => Promise<AdminUsageResponse>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockImplementation(async (query) => ({
        ...usage(query), byUser: [], othersCount: 0,
        totals: { sandboxSeconds: 0, openSandboxSeconds: 0, inputTokens: 0, outputTokens: 0 },
        byDay: usage(query).byDay.map((day) => ({ ...day, sandboxSeconds: 0, inputTokens: 0, outputTokens: 0 })),
      }));
    await render(shell("usage", <AdminUsagePanel request={request} now={NOW} timeZone={TZ} />));
    await expect.element(page.getByText("Не удалось загрузить данные")).toBeVisible();
    await page.getByRole("button", { name: "Повторить" }).click();
    await expect.element(page.getByText("За этот период расхода нет")).toBeVisible();
    await page.getByRole("button", { name: "Свой период" }).click();
    const before = request.mock.calls.length;
    await page.getByLabelText("Начало периода").fill("2027-01-01");
    await expect.element(page.getByRole("alert")).toHaveTextContent(
      "Выберите от 1 до 366 дней; начало не должно быть позже конца.",
    );
    expect(request.mock.calls).toHaveLength(before);
    expectNoHorizontalScroll();
  });
}

test("опрос песочниц: 10 секунд, пауза скрытой вкладки, возобновление и очистка", async () => {
  const request = vi.fn(async () => sandboxes());
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  const screen = await renderOnDesktop(<AdminSandboxesPanel initialData={sandboxes()} request={request} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(9999); });
  expect(request).not.toHaveBeenCalled();
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(request).toHaveBeenCalledTimes(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
  expect(request).toHaveBeenCalledTimes(2);
  visibility.mockReturnValue("hidden");
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(request).toHaveBeenCalledTimes(2);
  visibility.mockReturnValue("visible");
  await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
  expect(request).toHaveBeenCalledTimes(3);
  await screen.unmount();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(request).toHaveBeenCalledTimes(3);
});

test("HTTP-клиенты используют контрактные пути и no-store", async () => {
  const fetchMock = vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(Response.json(sandboxes()))
    .mockResolvedValueOnce(Response.json(usage()));
  await fetchAdminSandboxes();
  const query = { from: "2026-11-10", to: "2026-11-16", tz: TZ, userId: USER.id };
  await fetchAdminUsage(query);
  expect(fetchMock.mock.calls[0]![0]).toBe("/api/admin/sandboxes");
  expect(fetchMock.mock.calls[0]![1]?.cache).toBe("no-store");
  const url = new URL(String(fetchMock.mock.calls[1]![0]), "http://localhost");
  expect(url.pathname).toBe("/api/admin/usage");
  expect(Object.fromEntries(url.searchParams)).toEqual(query);
});

test("часовой пояс браузера определяется после монтирования; старый ответ не заменяет новый период", async () => {
  const calls: { query: UsageQuery; signal?: AbortSignal; resolve: (value: AdminUsageResponse) => void }[] = [];
  await renderOnDesktop(<AdminUsagePanel now={NOW} request={(query, signal) =>
    new Promise((resolve) => calls.push({ query, signal, resolve }))} />);
  await expect.poll(() => calls.length).toBe(1);
  expect(calls[0]!.query.tz).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
  await expect.element(page.getByRole("status", { name: "Загрузка данных" })).toBeVisible();
  await page.getByRole("button", { name: "Сегодня", exact: true }).click();
  await expect.poll(() => calls.length).toBe(2);
  expect(calls[0]!.signal?.aborted).toBe(true);
  await act(async () => { calls[1]!.resolve(usage(calls[1]!.query)); });
  await expect.poll(() => document.querySelectorAll(".recharts-bar-rectangle").length).toBe(1);
  await act(async () => { calls[0]!.resolve(usage(calls[0]!.query)); });
  expect(document.querySelectorAll(".recharts-bar-rectangle")).toHaveLength(1);
});

test("календарные даты: пояс браузера, переход месяца, валидация", () => {
  const nearMidnight = new Date("2026-11-16T23:30:00Z");
  expect(usagePeriod(1, "Asia/Tokyo", nearMidnight)).toEqual({ from: "2026-11-17", to: "2026-11-17" });
  expect(usagePeriod(7, "UTC", new Date("2026-11-01T12:00:00Z")))
    .toEqual({ from: "2026-10-26", to: "2026-11-01" });
  expect(validUsageDates("2026-02-30", "2026-03-01")).toBe(false);
  expect(validUsageDates("2026-01-01", "2027-01-02")).toBe(false);
  expect(validUsageDates("2026-01-02", "2026-01-01")).toBe(false);
  expect(validUsageDates("2026-01-01", "2026-01-01")).toBe(true);
});

test("общая проверка дат: годы, календарь и включённые границы периода", () => {
  for (const date of ["0000-01-01", "0000-12-31", "2026-02-29", "2026-13-01", "2026-00-01", "2026-01-00", "2026-01-32", "2026-1-01", "10000-01-01", ""]) {
    expect(validUsageDate(date), date).toBe(false);
    expect(validUsageDates(date, "2026-11-16"), date).toBe(false);
    expect(validUsageDates("2026-11-16", date), date).toBe(false);
  }
  for (const date of ["0001-01-01", "9999-12-31", "2024-02-29"]) {
    expect(validUsageDate(date), date).toBe(true);
    expect(validUsageDates(date, date), date).toBe(true);
  }
  expect(validUsageDates("2024-01-01", "2024-12-31")).toBe(true);
  expect(validUsageDates("2024-01-01", "2025-01-01")).toBe(false);
  expect(validUsageDates("2026-01-02", "2026-01-01")).toBe(false);
});
