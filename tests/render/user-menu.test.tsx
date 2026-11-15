import { expect, test, vi } from "vitest";
import { page } from "vitest/browser";

import { AppShell } from "@/components/studio/app-shell";
import { navItems } from "@/components/studio/nav";
import { UserMenu } from "@/components/studio/user-menu";
import type { PublicUser } from "@/lib/auth/user";

import { expectNoHorizontalScroll, renderOnDesktop, renderOnPhone } from "./support/render";

const user: PublicUser = {
  id: "00000000-0000-4000-8000-000000000000",
  name: "Иван Петров",
  username: "ivan",
  photoUrl: null,
  isOperator: false,
};

function shell(account: PublicUser, onLogout: () => void = () => {}) {
  return (
    <AppShell
      navItems={navItems}
      pathname="/s"
      userSlot={<UserMenu user={account} onLogout={onLogout} />}
    >
      Содержимое
    </AppShell>
  );
}

test("блок пользователя показывает имя, @username и инициалы", async () => {
  await renderOnDesktop(shell(user));

  await expect.element(page.getByText("Иван Петров").first()).toBeVisible();
  await expect.element(page.getByText("@ivan")).toBeVisible();
  await expect.element(page.getByText("ИП")).toBeVisible();
});

test("пункт «Выйти» вызывает обработчик", async () => {
  const onLogout = vi.fn();
  await renderOnDesktop(shell(user, onLogout));

  await page.getByRole("button", { name: "Аккаунт Иван Петров" }).click();
  await page.getByRole("menuitem", { name: "Выйти" }).click();

  expect(onLogout).toHaveBeenCalledTimes(1);
});

test("дополнительные пункты меню ведут в настройки и сохраняют выход", async () => {
  await renderOnDesktop(
    <AppShell
      navItems={navItems}
      pathname="/s"
      userSlot={
        <UserMenu
          user={user}
          onLogout={() => {}}
          items={[{ title: "Настройки", href: "/settings", icon: "settings" }]}
        />
      }
    >
      Содержимое
    </AppShell>,
  );
  await page.getByRole("button", { name: "Аккаунт Иван Петров" }).click();
  await expect.element(page.getByRole("menuitem", { name: "Настройки" })).toHaveAttribute("href", "/settings");
  await expect.element(page.getByRole("menuitem", { name: "Выйти" })).toBeVisible();
});

test("ошибка выхода остаётся видимой и позволяет повторить", async () => {
  const onLogout = vi.fn().mockRejectedValueOnce(new Error("failed")).mockResolvedValueOnce(undefined);
  await renderOnDesktop(shell(user, onLogout));
  await page.getByRole("button", { name: "Аккаунт Иван Петров" }).click();
  await page.getByRole("menuitem", { name: "Выйти" }).click();
  await expect.element(page.getByRole("alert")).toHaveTextContent("Не удалось выйти. Попробуйте ещё раз.");
  await page.getByRole("menuitem", { name: "Выйти" }).click();
  expect(onLogout).toHaveBeenCalledTimes(2);
});

test("имя в 200 символов не даёт горизонтальной прокрутки", async () => {
  await renderOnDesktop(shell({ ...user, name: "Я".repeat(200) }));

  expectNoHorizontalScroll();
});

test("длинное имя в блоке пользователя не расширяет телефон", async () => {
  await renderOnPhone(shell({ ...user, name: "Я".repeat(200) }));

  expectNoHorizontalScroll();
});
