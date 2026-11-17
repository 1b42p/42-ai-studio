import { act } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { page, userEvent } from "vitest/browser";

import { AdminKeysPanel } from "@/components/studio/admin/keys/admin-keys-panel";
import { AdminUsersPanel } from "@/components/studio/admin/users/admin-users-panel";
import { UserActionsMenu } from "@/components/studio/admin/users/user-actions-menu";
import { AdminShell } from "@/components/studio/admin/admin-shell";
import { adminSections } from "@/components/studio/admin/sections";
import type { AdminKeyView } from "@/lib/admin/key-view";
import type { AdminUserItem, AdminUsersPage } from "@/lib/admin/types";
import { expectNoHorizontalScroll, renderOnDesktop, renderOnPhone } from "./support/render";

const NOW = new Date("2026-11-17T12:00:00Z");
const KEY: AdminKeyView = {
  id: "00000000-0000-4000-8000-000000000001",
  label: "Основной", enabled: true, deletedAt: null, order: 1,
  createdAt: NOW.toISOString(), usageCheckedAt: null, exhaustedUntil: null,
  fits: 2, remainingSandboxes: null, warning: null,
  sandboxes: { running: 1, stopped: 0, archived: 0 },
  usage: {
    source: "daytona", fetchedAt: "2026-11-17T11:58:00Z",
    organizationId: "org", region: "eu", error: null, maxPerSandbox: null,
    cpu: { used: 4, quota: 10 }, memoryGb: { used: 8, quota: 16 }, diskGb: { used: 8, quota: 40 },
  },
};
const USER: AdminUserItem = {
  id: "00000000-0000-4000-8000-000000000002",
  telegramId: "123456789", name: "Иван Петров", username: "ivan", photoUrl: null,
  isOperator: false, isBlocked: false, deletionRequestedAt: null,
  sessionCount: 1, stuckDeletions: 0, createdAt: NOW.toISOString(), lastLoginAt: null,
};
const NEXT_USER = { ...USER, id: "00000000-0000-4000-8000-000000000003", name: "Анна Волкова" };
const totals = { users: 2, operators: 0, blocked: 0 };
const firstPage: AdminUsersPage = { items: [USER], nextCursor: "next-page-cursor", totals };
const nextPage: AdminUsersPage = { items: [NEXT_USER], nextCursor: null, totals };
const defaults = { cpu: 2, memoryGb: 4, diskGb: 8 };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

for (const [viewport, render] of [
  ["desktop", renderOnDesktop], ["phone", renderOnPhone],
] as const) {
  test(`${viewport}: обновление квот — отказ, сохранение данных, повтор и завершение пакета`, async () => {
    const second = { ...KEY, id: "00000000-0000-4000-8000-000000000004", label: "Запасной" };
    const waiting = deferred<AdminKeyView>();
    const refresh = vi.fn<(id: string) => Promise<AdminKeyView>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockImplementationOnce(() => waiting.promise)
      .mockResolvedValueOnce(KEY);
    await render(
      <AdminShell sections={adminSections} pathname="/admin/keys">
        <AdminKeysPanel initialPage={{ items: [KEY, second], defaults }}
          now={NOW} refreshRequest={refresh} timeZone="Europe/Moscow" />
      </AdminShell>,
    );
    const batch = page.getByRole("button", { name: "Обновить", exact: true });
    await batch.click();
    await expect.element(batch).toBeDisabled();
    await expect.element(page.getByRole("status", { name: "Обновление ключей" })).toBeVisible();
    await expect.poll(() => refresh.mock.calls.length).toBe(2);
    await expect.element(page.getByText(/Не удалось обновить квоты\. Показаны последние полученные данные\./)).toBeVisible();
    await expect.element(page.getByText("vCPU: 4 из 10").first()).toBeVisible();
    // Даже повторное событие во время пакета не запускает ещё один проход.
    await act(async () => { batch.element().dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(refresh).toHaveBeenCalledTimes(2);
    await page.screenshot({ path: `../../.vitest/attachments/site-admin-audit-${viewport}-refresh-error.png` });
    await act(async () => { waiting.resolve(second); });
    await expect.element(batch).toBeEnabled();
    await page.getByRole("button", { name: "Повторить обновление Основной" }).click();
    await expect.element(page.getByText(/Не удалось обновить квоты\. Показаны последние полученные данные\./)).not.toBeInTheDocument();
    await expect.poll(() => refresh.mock.calls.length).toBe(3);
    expect(refresh.mock.calls.map(([id]) => id)).toEqual([KEY.id, second.id, KEY.id]);
    await expect.element(page.getByRole("button", { name: "Обновить Основной", exact: true })).toBeEnabled();
    expectNoHorizontalScroll();
  });

  test(`${viewport}: отказ следующей страницы не прячет пользователей, повтор сохраняет курсор и фильтр`, async () => {
    const waiting = deferred<AdminUsersPage>();
    const request = vi.fn<NonNullable<Parameters<typeof AdminUsersPanel>[0]["request"]>>()
      .mockResolvedValueOnce(firstPage)
      .mockRejectedValueOnce(new Error("offline"))
      .mockImplementationOnce(() => waiting.promise);
    await render(
      <AdminShell sections={adminSections} pathname="/admin/users">
        <AdminUsersPanel initialPage={firstPage} request={request} now={NOW} timeZone="Europe/Moscow" />
      </AdminShell>,
    );
    await page.getByRole("textbox", { name: "Поиск по @username и Telegram ID" }).fill("ivan");
    await expect.poll(() => request.mock.calls.length).toBe(1);
    await page.getByRole("button", { name: "Показать ещё" }).click();
    const error = page.getByRole("alert");
    await expect.element(error).toBeVisible();
    const existing = page.getByRole("button", { name: `Действия для ${USER.name}` });
    await expect.element(existing).toBeVisible();
    const identity = existing.element().getBoundingClientRect();
    expect(error.element().getBoundingClientRect().top).toBeGreaterThan(identity.top);
    await page.screenshot({ path: `../../.vitest/attachments/site-admin-audit-${viewport}-users-retry.png` });
    await page.getByRole("button", { name: "Повторить", exact: true }).click();
    await expect.element(existing).toBeVisible();
    expect(request.mock.calls[1]?.[0]).toEqual({ q: "ivan", cursor: "next-page-cursor", userId: null });
    expect(request.mock.calls[2]?.[0]).toEqual(request.mock.calls[1]?.[0]);
    await act(async () => { waiting.resolve(nextPage); });
    await expect.element(page.getByRole("button", { name: `Действия для ${NEXT_USER.name}` })).toBeVisible();
    await expect.element(existing).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Показать ещё" })).not.toBeInTheDocument();
    expectNoHorizontalScroll();
  });

  test(`${viewport}: причины запрета видимы при открытии меню, включая клавиатуру`, async () => {
    const onAction = vi.fn();
    const screen = await render(<UserActionsMenu user={{ ...USER, isOperator: true }} onAction={onAction} />);
    const trigger = page.getByRole("button", { name: `Действия для ${USER.name}` });
    if (viewport === "desktop") {
      (trigger.element() as HTMLElement).focus();
      await userEvent.keyboard("{Enter}");
    } else {
      await trigger.click();
    }
    const reason = page.getByText("Оператора нельзя заблокировать или удалить");
    await expect.element(reason).toBeVisible();
    const disabled = page.getByRole("menuitem", { name: "Заблокировать", exact: true });
    await expect.element(disabled).toHaveAttribute("aria-disabled", "true");
    expect(disabled.element().getAttribute("aria-describedby")).toBe(reason.element().id);
    expect(disabled.element().scrollWidth).toBeLessThanOrEqual(disabled.element().clientWidth);
    await page.screenshot({ path: `../../.vitest/attachments/site-admin-audit-${viewport}-disabled-actions.png` });
    await userEvent.keyboard("{ArrowDown}{Enter}");
    expect(onAction).not.toHaveBeenCalled();
    await userEvent.keyboard("{Escape}");
    expectNoHorizontalScroll();
    await screen.unmount();
    await render(<UserActionsMenu user={{
      ...USER, isBlocked: true, deletionRequestedAt: NOW.toISOString(),
    }} onAction={onAction} />);
    await page.getByRole("button", { name: `Действия для ${USER.name}` }).click();
    await expect.element(page.getByText("Пользователь удаляется, разблокировать нельзя.")).toBeVisible();
    await expect.element(page.getByRole("menuitem", { name: "Разблокировать" })).toHaveAttribute("aria-disabled", "true");
    await expect.element(page.getByRole("menuitem", { name: "Продолжить удаление" })).toBeVisible();
    expectNoHorizontalScroll();
  });
}

test("свежесть ключей обновляется после refresh и только на видимой странице, без сетевого опроса", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  vi.setSystemTime(NOW);
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  const refresh = vi.fn(async () => ({
    ...KEY, usage: { ...KEY.usage!, fetchedAt: new Date().toISOString() },
  }));
  const screen = await renderOnDesktop(
    <AdminKeysPanel initialPage={{ items: [{ ...KEY, exhaustedUntil: "2026-11-17T12:01:00Z" }], defaults }}
      refreshRequest={refresh} timeZone="Europe/Moscow" />,
  );
  await expect.element(page.getByText("Данные получены: 2 мин назад")).toBeVisible();
  await expect.element(page.getByText("Квота исчерпана до 15:01")).toBeVisible();
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  await expect.element(page.getByText("Данные получены: 3 мин назад")).toBeVisible();
  await expect.element(page.getByText("Квота исчерпана до 15:01")).not.toBeInTheDocument();
  visibility.mockReturnValue("hidden");
  await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
  await act(async () => { await vi.advanceTimersByTimeAsync(180_000); });
  await expect.element(page.getByText("Данные получены: 3 мин назад")).toBeVisible();
  visibility.mockReturnValue("visible");
  await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
  await expect.element(page.getByText("Данные получены: 6 мин назад")).toBeVisible();
  expect(refresh).not.toHaveBeenCalled();
  // Обновление до следующего минутного тика сразу показывает настоящее время.
  vi.setSystemTime(new Date("2026-11-17T12:04:30Z"));
  await page.getByRole("button", { name: "Обновить Основной", exact: true }).click();
  await expect.element(page.getByText("Данные получены: только что")).toBeVisible();
  expect(refresh).toHaveBeenCalledTimes(1);
  await screen.unmount();
  expect(vi.getTimerCount()).toBe(0);
});
