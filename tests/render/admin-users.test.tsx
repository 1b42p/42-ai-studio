/**
 * Админка: список пользователей, диалоги и переключатель разделов в окнах
 * 390×844 и 1280×800. Даты заданы литералами для фиксированного момента.
 */
import { expect, test, vi } from "vitest";
import { page, userEvent } from "vitest/browser";

import { AdminShell } from "@/components/studio/admin/admin-shell";
import { AdminUsersPanel } from "@/components/studio/admin/users/admin-users-panel";
import { AdminUsersError } from "@/components/studio/admin/users/admin-users-data";
import { AppShell } from "@/components/studio/app-shell";
import { navItemsFor } from "@/components/studio/nav";
import type {
  AdminUserDeleteResponse,
  AdminUserItem,
  AdminUsersPage,
} from "@/lib/admin/types";

import { expectNoHorizontalScroll, renderOnDesktop, renderOnPhone } from "./support/render";

const NOW = new Date("2026-11-01T12:00:00Z");
const ZONE = "Europe/Moscow";
const OPERATOR_HINT = "Оператора нельзя заблокировать или удалить";

function user(overrides: Partial<AdminUserItem> = {}): AdminUserItem {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    telegramId: "123456789",
    name: "Иван Петров",
    username: "ivan",
    photoUrl: null,
    isOperator: false,
    isBlocked: false,
    deletionRequestedAt: null,
    sessionCount: 3,
    stuckDeletions: 0,
    createdAt: "2026-10-12T12:00:00.000Z",
    lastLoginAt: "2026-11-01T11:05:00.000Z",
    ...overrides,
  };
}

const IVAN = user();
const OLGA = user({
  id: "00000000-0000-4000-8000-000000000002",
  telegramId: "987654321",
  name: "Ольга Смирнова",
  username: null,
  isBlocked: true,
  sessionCount: 1,
  stuckDeletions: 2,
  lastLoginAt: "2026-10-31T06:30:00.000Z",
});
const OPERATOR = user({
  id: "00000000-0000-4000-8000-000000000003",
  telegramId: "555000111",
  name: "Главный оператор",
  username: "boss",
  isOperator: true,
});
const DELETING = user({
  id: "00000000-0000-4000-8000-000000000004",
  telegramId: "777000222",
  name: "Удаляемый человек",
  username: "leaving",
  isBlocked: true,
  deletionRequestedAt: "2026-11-01T10:00:00.000Z",
});

function pageOf(items: readonly AdminUserItem[], nextCursor: string | null = null): AdminUsersPage {
  return {
    items,
    nextCursor,
    totals: {
      users: items.length,
      operators: items.filter((item) => item.isOperator).length,
      blocked: items.filter((item) => item.isBlocked).length,
    },
  };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function panel(
  initialPage: AdminUsersPage,
  props: Partial<Parameters<typeof AdminUsersPanel>[0]> = {},
) {
  return (
    <AdminUsersPanel
      initialPage={initialPage}
      now={NOW}
      request={async () => pageOf([])}
      timeZone={ZONE}
      {...props}
    />
  );
}

test("компьютер: таблица показывает поля, метки и застрявшие удаления", async () => {
  const screen = await renderOnDesktop(panel(pageOf([IVAN, OLGA, OPERATOR, DELETING])));
  const table = page.getByRole("table");

  await expect.element(table).toBeVisible();
  await expect.element(page.getByText("Всего 4 · Операторов 1 · Заблокировано 2")).toBeVisible();
  for (const heading of [
    "Пользователь",
    "Telegram ID",
    "Сессий",
    "Первый вход",
    "Последний вход",
    "Статус",
  ]) {
    await expect.element(page.getByRole("columnheader", { name: heading })).toBeVisible();
  }

  await expect.element(table.getByText("Иван Петров")).toBeVisible();
  await expect.element(table.getByText("@ivan")).toBeVisible();
  await expect.element(table.getByText("123456789")).toBeVisible();
  await expect.element(table.getByText("сегодня, 14:05").first()).toBeVisible();
  await expect.element(table.getByText("12 октября").first()).toBeVisible();
  await expect.element(table.getByText("Оператор")).toBeVisible();
  await expect.element(table.getByText("Заблокирован")).toBeVisible();
  await expect.element(table.getByText("Удаляется")).toBeVisible();
  await expect.element(table.getByText("Застряло удалений: 2")).toBeVisible();
  expectNoHorizontalScroll();
  await screen.unmount();
});

test("меню действий: обычный пользователь, оператор и удаляемый", async () => {
  await renderOnDesktop(panel(pageOf([IVAN, OPERATOR, DELETING])));

  await page.getByRole("button", { name: "Действия для Иван Петров" }).click();
  await expect.element(page.getByRole("menuitem", { name: "Заблокировать" })).toBeVisible();
  await expect.element(page.getByRole("menuitem", { name: "Удалить" })).toBeVisible();
  await userEvent.keyboard("{Escape}");

  await page.getByRole("button", { name: "Действия для Главный оператор" }).click();
  const operatorBlock = page.getByRole("menuitem", { name: "Заблокировать" });
  await expect.element(operatorBlock).toHaveAttribute("aria-disabled", "true");
  await expect.element(page.getByText(OPERATOR_HINT)).toBeVisible();
  await userEvent.keyboard("{Escape}");

  await page.getByRole("button", { name: "Действия для Удаляемый человек" }).click();
  await expect.element(page.getByRole("menuitem", { name: "Разблокировать" }))
    .toHaveAttribute("aria-disabled", "true");
  await expect.element(page.getByRole("menuitem", { name: "Продолжить удаление" })).toBeVisible();
});

test("телефон: карточки с теми же полями, длинное имя усечено, прокрутки нет", async () => {
  const longName = "я".repeat(200);
  const long = user({
    id: "00000000-0000-4000-8000-000000000099",
    telegramId: "101010101",
    name: longName,
    username: "long",
    sessionCount: 7,
  });
  const screen = await renderOnPhone(panel(pageOf([IVAN, long])));

  await expect.element(page.getByText("Telegram ID: 123456789")).toBeVisible();
  await expect.element(page.getByText("Сессий: 3")).toBeVisible();
  const cards = [...document.querySelectorAll("[data-slot=item]")];
  expect(cards[0]?.textContent).toContain("Первый вход:");
  expect(cards[0]?.textContent).toContain("Последний вход:");
  expect(cards[1]?.textContent).toContain("Сессий: 7");
  await expect.element(page.getByRole("button", { name: `Действия для ${longName}` })).toBeVisible();

  const title = [...document.querySelectorAll("[data-slot=item-title]")].find(
    (node) => node.textContent === longName,
  ) as HTMLElement;
  expect(title).toBeDefined();
  expect(title.getClientRects().length).toBe(1);
  expect(title.scrollWidth).toBeGreaterThan(title.clientWidth);
  expectNoHorizontalScroll();
  await screen.unmount();
});

test("телефон: без last_login_at подписи «Первый вход» нет", async () => {
  await renderOnPhone(
    panel(pageOf([user({ lastLoginAt: null, name: "Никогда не входил" })])),
  );
  const card = document.querySelector("[data-slot=item]");
  expect(card?.textContent).not.toContain("Первый вход");
  expect(card?.textContent).toContain("Последний вход: —");
});

test("поиск с задержкой, пустой результат и сброс", async () => {
  const calls: string[] = [];
  const screen = await renderOnDesktop(
    panel(pageOf([IVAN]), {
      request: async (input) => {
        calls.push(input.q);
        return input.q === "" ? pageOf([IVAN]) : pageOf([]);
      },
    }),
  );

  const search = page.getByRole("textbox", { name: "Поиск по @username и Telegram ID" });
  await search.fill("  @ivan ");
  expect(calls).toEqual([]);
  await wait(100);
  expect(calls).toEqual([]);
  await wait(250);
  expect(calls).toEqual(["@ivan"]);
  await expect.element(page.getByText("Никого не найдено по запросу «@ivan»")).toBeVisible();

  await page.getByRole("button", { name: "Сбросить поиск" }).click();
  await expect.element(page.getByRole("table").getByText("Иван Петров")).toBeVisible();
  expect(calls).toEqual(["@ivan", ""]);
  expect(
    (document.querySelector("input[aria-label='Поиск по @username и Telegram ID']") as HTMLInputElement).value,
  ).toBe("");
  await screen.unmount();
});

test("состояния: скелеты, ошибка и повтор, пустой список", async () => {
  let resolveSearch: ((value: AdminUsersPage) => void) | undefined;
  const loadingScreen = await renderOnDesktop(
    panel(pageOf([IVAN]), {
      request: () =>
        new Promise((resolve) => {
          resolveSearch = resolve;
        }),
    }),
  );
  await page.getByRole("textbox", { name: "Поиск по @username и Telegram ID" }).fill("ольга");
  await wait(400);
  expect(document.querySelectorAll("[data-slot=skeleton]").length).toBeGreaterThanOrEqual(5);
  resolveSearch?.(pageOf([]));
  await loadingScreen.unmount();

  let retried = 0;
  const errorScreen = await renderOnDesktop(
    panel(pageOf([]), {
      initialError: true,
      request: async () => {
        retried += 1;
        return pageOf([IVAN]);
      },
    }),
  );
  await expect.element(page.getByText("Не удалось загрузить пользователей")).toBeVisible();
  await page.getByRole("button", { name: "Повторить" }).click();
  await expect.element(page.getByRole("table").getByText("Иван Петров")).toBeVisible();
  expect(retried).toBe(1);
  await errorScreen.unmount();

  const emptyScreen = await renderOnDesktop(panel(pageOf([])));
  await expect.element(page.getByText("Пользователей пока нет")).toBeVisible();
  await emptyScreen.unmount();
});

test("фильтр по пользователю: чип и сброс", async () => {
  const onResetFilter = vi.fn();
  await renderOnPhone(
    panel(pageOf([IVAN]), {
      initialUserId: IVAN.id,
      onResetFilter,
    }),
  );
  await expect.element(page.getByText("Фильтр: пользователь")).toBeVisible();
  await page.getByRole("button", { name: "Сбросить" }).click();
  expect(onResetFilter).toHaveBeenCalledTimes(1);
});

test("блокировка: «Отмена» не вызывает, подтверждение вызывает один раз", async () => {
  const blockRequest = vi.fn(async () => ({ ...IVAN, isBlocked: true }));
  await renderOnDesktop(panel(pageOf([IVAN]), { blockRequest }));

  await page.getByRole("button", { name: "Действия для Иван Петров" }).click();
  await page.getByRole("menuitem", { name: "Заблокировать" }).click();
  const dialog = page.getByRole("alertdialog", { name: "Заблокировать Иван Петров?" });
  await expect.element(dialog).toBeVisible();
  await expect.element(
    page.getByText(
      "Пользователь не сможет войти и продолжить работу в сессиях. Его данные сохранятся. Уже идущий ход агента завершится.",
    ),
  ).toBeVisible();
  await page.getByRole("button", { name: "Отмена" }).click();
  await expect.element(dialog).not.toBeInTheDocument();
  expect(blockRequest).not.toHaveBeenCalled();

  await page.getByRole("button", { name: "Действия для Иван Петров" }).click();
  await page.getByRole("menuitem", { name: "Заблокировать" }).click();
  await page.getByRole("button", { name: "Заблокировать", exact: true }).click();
  expect(blockRequest).toHaveBeenCalledExactlyOnceWith(IVAN.id, true);
  await expect.element(dialog).not.toBeInTheDocument();
  await expect.element(page.getByRole("table").getByText("Заблокирован")).toBeVisible();
});

test("разблокировка: свой текст и один вызов", async () => {
  const blocked = user({ isBlocked: true });
  const blockRequest = vi.fn(async () => ({ ...blocked, isBlocked: false }));
  await renderOnDesktop(panel(pageOf([blocked]), { blockRequest }));

  await page.getByRole("button", { name: "Действия для Иван Петров" }).click();
  await page.getByRole("menuitem", { name: "Разблокировать" }).click();
  const dialog = page.getByRole("alertdialog", { name: "Разблокировать Иван Петров?" });
  await expect.element(dialog).toBeVisible();
  await expect.element(page.getByText("Пользователь снова сможет войти.")).toBeVisible();
  await page.getByRole("button", { name: "Разблокировать", exact: true }).click();
  expect(blockRequest).toHaveBeenCalledExactlyOnceWith(IVAN.id, false);
  await expect.element(dialog).not.toBeInTheDocument();
});

test("удаление: кнопка активна только при точном Telegram ID и показывает прогресс", async () => {
  const pending: Array<(value: AdminUserDeleteResponse) => void> = [];
  const deleteRequest = vi.fn(
    () => new Promise<AdminUserDeleteResponse>((resolve) => { pending.push(resolve); }),
  );

  await renderOnDesktop(panel(pageOf([IVAN]), { deleteRequest }));
  await page.getByRole("button", { name: "Действия для Иван Петров" }).click();
  await page.getByRole("menuitem", { name: "Удалить" }).click();
  const dialog = page.getByRole("alertdialog", { name: "Удалить Иван Петров со всеми данными?" });
  await expect.element(dialog).toBeVisible();
  await expect.element(
    page.getByText(
      "Будут безвозвратно удалены его сессии, переписка, загруженные файлы, ролики и песочницы. Это действие нельзя отменить.",
    ),
  ).toBeVisible();

  const action = page.getByRole("button", { name: "Удалить", exact: true });
  const input = page.getByRole("textbox", { name: "Введите Telegram ID пользователя для подтверждения" });
  await expect.element(action).toBeDisabled();
  await input.fill("123");
  await expect.element(action).toBeDisabled();
  await input.fill("123456789 ");
  await expect.element(action).toBeDisabled();
  await input.fill("123456789");
  await expect.element(action).toBeEnabled();
  await action.click();

  expect(deleteRequest).toHaveBeenCalledTimes(1);
  pending[0]!({ done: false, deleted: 2, total: 5, remaining: { sessions: 3 } });
  await expect.poll(() => pending.length).toBe(2);
  await expect.element(page.getByText("Удалено сессий: 2 из 5")).toBeVisible();
  pending[1]!({ done: true });
  await expect.element(dialog).not.toBeInTheDocument();
  await expect.element(page.getByText("Иван Петров")).not.toBeInTheDocument();
});

test("удаление: 502 показывает текст ответа и повтор завершает", async () => {
  const failure = "Не удалось удалить часть данных (сессий: 1). Повторите удаление.";
  const deleteRequest = vi
    .fn<(id: string) => Promise<AdminUserDeleteResponse>>()
    .mockRejectedValueOnce(new AdminUsersError(failure))
    .mockResolvedValueOnce({ done: true });

  await renderOnDesktop(panel(pageOf([IVAN]), { deleteRequest }));
  await page.getByRole("button", { name: "Действия для Иван Петров" }).click();
  await page.getByRole("menuitem", { name: "Удалить" }).click();
  await page.getByRole("textbox", { name: "Введите Telegram ID пользователя для подтверждения" }).fill("123456789");
  await page.getByRole("button", { name: "Удалить", exact: true }).click();

  await expect.element(page.getByRole("alert")).toHaveTextContent(failure);
  const retry = page.getByRole("button", { name: "Повторить", exact: true });
  await expect.element(retry).toBeEnabled();
  await retry.click();
  await expect.element(page.getByRole("alertdialog")).not.toBeInTheDocument();
  expect(deleteRequest).toHaveBeenCalledTimes(2);
});

const SECTIONS = [
  { id: "users", title: "Пользователи", href: "/admin/users" },
  { id: "sandboxes", title: "Песочницы", href: "/admin/sandboxes" },
];

test("переключатель разделов: вкладки на компьютере", async () => {
  await renderOnDesktop(
    <AdminShell pathname="/admin/users" sections={SECTIONS}>
      Содержимое
    </AdminShell>,
  );
  await expect.element(page.getByRole("heading", { name: "Админка" })).toBeVisible();
  const users = page.getByRole("tab", { name: "Пользователи" });
  await expect.element(users).toHaveAttribute("href", "/admin/users");
  await expect.element(page.getByRole("tab", { name: "Песочницы" }))
    .toHaveAttribute("href", "/admin/sandboxes");
  await expect
    .element(page.getByRole("combobox", { name: "Раздел админки", includeHidden: true }))
    .not.toBeVisible();
  expectNoHorizontalScroll();
});

test("переключатель разделов: список на телефоне без прокрутки", async () => {
  const onNavigate = vi.fn();
  await renderOnPhone(
    <AdminShell
      onNavigate={onNavigate}
      pathname="/admin/users"
      sections={SECTIONS}
    >
      Содержимое
    </AdminShell>,
  );
  await expect
    .element(page.getByRole("tab", { name: "Пользователи", includeHidden: true }))
    .not.toBeVisible();
  const select = page.getByRole("combobox", { name: "Раздел админки" });
  await expect.element(select).toBeVisible();
  await select.click();
  await page.getByRole("option", { name: "Песочницы" }).click();
  expect(onNavigate).toHaveBeenCalledExactlyOnceWith("/admin/sandboxes");
  expectNoHorizontalScroll();
});

test("пункт «Админка» виден оператору и скрыт остальным", async () => {
  const ordinary = await renderOnDesktop(
    <AppShell navItems={navItemsFor(false)} pathname="/s">
      Содержимое
    </AppShell>,
  );
  expect(document.body.textContent).not.toContain("Админка");
  await ordinary.unmount();

  await renderOnDesktop(
    <AppShell navItems={navItemsFor(true)} pathname="/s">
      Содержимое
    </AppShell>,
  );
  const admin = page.getByRole("link", { name: "Админка" });
  await expect.element(admin).toBeVisible();
  await expect.element(admin).toHaveAttribute("href", "/admin");
});
