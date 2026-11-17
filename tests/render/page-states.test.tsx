import { afterEach, expect, test, vi } from "vitest";
import { page } from "vitest/browser";

import NotFound from "@/app/not-found";
import AppNotFound from "@/app/(app)/not-found";
import SessionNotFound from "@/app/(app)/s/[sessionId]/not-found";
import ErrorPage from "@/app/error";
import { AppShell } from "@/components/studio/app-shell";
import { navItems } from "@/components/studio/nav";
import { PageError } from "@/components/studio/page-error";
import { PublicShell } from "@/components/studio/public-shell";
import { PublicErrorLoading } from "@/components/studio/public-error-loading";

import { expectNoHorizontalScroll, renderOnDesktop, renderOnPhone } from "./support/render";

afterEach(() => {
  localStorage.clear();
});

test("запасной экран ошибки оставляет понятное объяснение и возврат без загруженного модуля восстановления", async () => {
  await renderOnPhone(<PublicErrorLoading />);
  await expect.element(page.getByRole("heading", { level: 1, name: "Не удалось открыть страницу" })).toBeVisible();
  await expect.element(page.getByRole("link", { name: "На главную", exact: true })).toHaveAttribute("href", "/");
  expectNoHorizontalScroll();
});

test("отложенный публичный экран ошибки открывается с рабочим повтором и ссылкой возврата", async () => {
  const retry = vi.fn();
  await renderOnPhone(<ErrorPage error={new Error("fixture")} retry={retry} />);
  await expect.element(page.getByRole("heading", { level: 1, name: "Не удалось открыть страницу" })).toBeVisible();
  await page.getByRole("button", { name: "Попробовать ещё раз" }).click();
  expect(retry).toHaveBeenCalledTimes(1);
  await expect.element(page.getByRole("link", { name: "На главную", exact: true })).toHaveAttribute("href", "/");
  expectNoHorizontalScroll();
});

for (const theme of ["light", "dark"]) {
  for (const [viewport, render] of [["телефон", renderOnPhone], ["компьютер", renderOnDesktop]] as const) {
    test(`${viewport}, ${theme}: неизвестная страница предлагает выход и сохраняет тему`, async () => {
      localStorage.setItem("theme", theme);
      await render(<NotFound />);
      await expect.element(page.getByRole("heading", { level: 1, name: "Страница не найдена" })).toBeVisible();
      await expect.element(page.getByRole("link", { name: "На главную", exact: true })).toHaveAttribute("href", "/");
      await expect.element(page.getByRole("link", { name: "Открыть студию", exact: true })).toHaveAttribute("href", "/s");
      await expect.poll(() => document.documentElement.classList.contains(theme)).toBe(true);
      expect(document.querySelectorAll("h1")).toHaveLength(1);
      expectNoHorizontalScroll();
    });

    test(`${viewport}, ${theme}: ошибка приложения оставляет навигацию и рабочий повтор`, async () => {
      localStorage.setItem("theme", theme);
      const retry = vi.fn();
      await render(
        <AppShell navItems={navItems} pathname="/s">
          <PageError retry={retry} inApp />
        </AppShell>,
      );
      await expect.element(page.getByRole("heading", { level: 1, name: "Не удалось открыть страницу" })).toBeVisible();
      await page.getByRole("button", { name: "Попробовать ещё раз" }).click();
      expect(retry).toHaveBeenCalledTimes(1);
      await expect.element(page.getByRole("link", { name: "К сессиям", exact: true })).toHaveAttribute("href", "/s");
      expectNoHorizontalScroll();
    });
  }
}

test("ссылки пропуска навигации переводят фокус к содержимому", async () => {
  await renderOnDesktop(<PublicShell><p>Содержимое страницы</p></PublicShell>);
  const link = page.getByRole("link", { name: "Перейти к содержимому" });
  (link.element() as HTMLElement).focus();
  await expect.element(link).toBeVisible();
  await link.click();
  expect(document.activeElement?.id).toBe("studio-content");
  expectNoHorizontalScroll();
});

test("404 приложения и сессии используют один язык и доступные ссылки возврата", async () => {
  await renderOnPhone(<><AppNotFound /><SessionNotFound /></>);
  await expect.element(page.getByRole("heading", { name: "Сессия не найдена", exact: true })).toBeVisible();
  const links = page.getByRole("link", { name: "К сессиям", exact: true }).elements();
  expect(links).toHaveLength(2);
  for (const link of links) expect(link.getAttribute("href")).toBe("/s");
  expectNoHorizontalScroll();
});
