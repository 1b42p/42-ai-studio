import { useState } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { commands, page } from "vitest/browser";

import { AppShell } from "@/components/studio/app-shell";
import { navItems } from "@/components/studio/nav";
import { SettingsPage } from "@/components/studio/settings/settings-page";
import { SettingsValidationError } from "@/components/studio/settings/settings-error";
import { useSettings } from "@/components/studio/settings/use-settings";
import type { PublicUser } from "@/lib/auth/user";
import { normalizeCustomInstructions, type Settings, type SettingsPatch } from "@/lib/settings/schema";

import { expectNoHorizontalScroll, renderOnDesktop, renderOnPhone } from "./support/render";

const user: PublicUser = {
  id: "00000000-0000-4000-8000-000000000000",
  name: "Иван Петров",
  username: "ivan",
  photoUrl: null,
  isOperator: false,
};

beforeEach(async () => {
  localStorage.clear();
  document.documentElement.classList.remove("light", "dark");
  await commands.emulateColorScheme("light");
});

afterEach(() => vi.restoreAllMocks());

function StatefulSettings({
  initial = "Пиши кратко.",
  initialMemoryEnabled = false,
  save,
}: {
  initial?: string;
  initialMemoryEnabled?: boolean;
  save?: (patch: SettingsPatch) => Promise<Settings>;
}) {
  const [settings, setSettings] = useState({
    customInstructions: initial,
    memoryEnabled: initialMemoryEnabled,
  });
  return (
    <SettingsPage
      settings={settings}
      save={async (patch) => {
        const next = save ? await save(patch) : {
          ...settings,
          ...patch,
          customInstructions: normalizeCustomInstructions(patch.customInstructions ?? settings.customInstructions),
        };
        setSettings(next);
        return next;
      }}
      user={user}
      onLogout={() => {}}
    />
  );
}

function NetworkSettings() {
  const { settings, save } = useSettings({ customInstructions: "Начальные указания", memoryEnabled: false });
  return <SettingsPage settings={settings} save={save} user={user} onLogout={() => {}} />;
}

test("настройки показывают разделы, заполненное поле и аккаунт на телефоне", async () => {
  const onLogout = vi.fn();
  await renderOnPhone(
    <SettingsPage
      settings={{ customInstructions: "Пиши кратко.", memoryEnabled: false }}
      save={vi.fn()}
      user={user}
      onLogout={onLogout}
    />,
  );

  for (const name of ["Тема", "Общие указания для агента", "MCP-серверы", "Память", "Аккаунт"]) {
    await expect.element(page.getByRole("heading", { name, exact: true })).toBeVisible();
  }
  await expect.element(page.getByRole("textbox", { name: "Общие указания" })).toHaveValue("Пиши кратко.");
  await expect.element(page.getByRole("button", { name: "Сохранить" })).toBeDisabled();
  await expect.element(page.getByText("@ivan")).toBeVisible();
  await page.getByRole("button", { name: "Выйти" }).click();
  expect(onLogout).toHaveBeenCalledTimes(1);
  expectNoHorizontalScroll();
});

test("компьютер: боковая навигация настроек, секции и длинное поле не расширяют страницу", async () => {
  await renderOnDesktop(
    <AppShell navItems={navItems} pathname="/settings">
      <StatefulSettings initial={"Я".repeat(4000)} />
    </AppShell>,
  );

  await expect.element(page.getByRole("link", { name: "Настройки" })).toHaveAttribute("href", "/settings");
  await expect.element(page.getByText("4000 из 4000")).toBeVisible();
  const regions = page.getByRole("region").elements();
  expect(regions).toHaveLength(5);
  expect(regions.map((region) => region.getAttribute("aria-labelledby"))).toEqual([
    "settings-theme", "settings-instructions", "settings-memory", "settings-mcp", "settings-account",
  ]);
  const bounds = regions.map((region) => region.getBoundingClientRect());
  const navigation = page.getByRole("navigation", { name: "Разделы настроек" }).element().getBoundingClientRect();
  const main = page.getByRole("main").element().getBoundingClientRect();
  expect(navigation.right).toBeLessThanOrEqual(bounds[0].left);
  expect(bounds.every((rect) => rect.right <= main.right && rect.left >= main.left)).toBe(true);
  expect(bounds[0].x).toBe(bounds[1].x);
  expect(bounds[1].bottom).toBeLessThan(bounds[2].top);
  expectNoHorizontalScroll();
});

test("телефон: 4000 символов без пробелов, длинное имя и кнопки во всю ширину", async () => {
  await renderOnPhone(
    <SettingsPage
      settings={{ customInstructions: "Я".repeat(4000), memoryEnabled: false }}
      save={vi.fn()}
      user={{ ...user, name: "Я".repeat(200), username: "a".repeat(200) }}
      onLogout={() => {}}
    />,
  );
  await expect.element(page.getByText("4000 из 4000")).toBeVisible();
  const save = page.getByRole("button", { name: "Сохранить" }).element().getBoundingClientRect();
  const field = page.getByRole("textbox").element().getBoundingClientRect();
  expect(save.width).toBe(field.width);
  expectNoHorizontalScroll();
});

test("нормализация, счётчик кодовых точек и предел управляют сохранением", async () => {
  await renderOnDesktop(<StatefulSettings />);
  const field = page.getByRole("textbox", { name: "Общие указания" });
  const save = page.getByRole("button", { name: "Сохранить" });

  await field.fill("Пиши кратко. \n\u200B");
  await expect.element(save).toBeDisabled();
  await expect.element(page.getByText("12 из 4000")).toBeVisible();

  await field.fill("😀".repeat(4000));
  await expect.element(page.getByText("4000 из 4000")).toBeVisible();
  await expect.element(save).toBeEnabled();
  expect(field.element().getAttribute("maxlength")).toBeNull();
  expectNoHorizontalScroll();

  await field.fill("😀".repeat(4001));
  await expect.element(page.getByText("4001 из 4000")).toHaveClass("text-destructive");
  await expect.element(field).toHaveAttribute("aria-invalid", "true");
  await expect.element(save).toBeDisabled();
});

test("сохранение показывает спиннер, блокирует повтор и подтверждает успех", async () => {
  const pending = Promise.withResolvers<Settings>();
  const save = vi.fn(() => pending.promise);
  await renderOnDesktop(<StatefulSettings save={save} />);
  const field = page.getByRole("textbox", { name: "Общие указания" });
  const button = page.getByRole("button", { name: "Сохранить" });
  await field.fill("  На русском.  ");
  await button.click();
  await expect.element(button).toBeDisabled();
  await expect.element(field).toBeDisabled();
  await expect.element(page.getByRole("status", { name: "Сохранение" })).toBeVisible();
  expect(save).toHaveBeenCalledExactlyOnceWith({ customInstructions: "На русском." });

  pending.resolve({ customInstructions: "На русском.", memoryEnabled: false });
  await expect.element(page.getByText("Сохранено", { exact: true })).toBeVisible();
  await expect.element(field).toHaveValue("На русском.");
  await expect.element(button).toBeDisabled();
  await field.fill("");
  await expect.element(button).toBeEnabled();
});

test("ошибка не теряет текст, повтор сохраняет, очистка отправляет пустую строку", async () => {
  const save = vi.fn()
    .mockRejectedValueOnce(new Error("private internal details"))
    .mockResolvedValueOnce({ customInstructions: "", memoryEnabled: false });
  await renderOnDesktop(<StatefulSettings save={save} />);
  const field = page.getByRole("textbox", { name: "Общие указания" });
  const button = page.getByRole("button", { name: "Сохранить" });
  await field.fill("");
  await button.click();
  await expect.element(page.getByRole("alert")).toHaveTextContent("Не удалось сохранить. Попробуйте ещё раз.");
  await expect.element(field).toHaveValue("");
  await expect.element(button).toBeEnabled();
  await button.click();
  expect(save).toHaveBeenLastCalledWith({ customInstructions: "" });
  await expect.element(page.getByText("Сохранено", { exact: true })).toBeVisible();
  await expect.element(page.getByRole("alert")).not.toBeInTheDocument();
});

test("валидация показывает текст API", async () => {
  await renderOnDesktop(
    <StatefulSettings save={async () => {
      throw new SettingsValidationError("Проверьте общие указания.");
    }} />,
  );
  await page.getByRole("textbox").fill("Новый текст");
  await page.getByRole("button", { name: "Сохранить" }).click();
  await expect.element(page.getByRole("alert")).toHaveTextContent("Проверьте общие указания.");
});

test("тема меняет класс, хранится после открытия и следует системной схеме", async () => {
  const first = await renderOnDesktop(<StatefulSettings />);
  await page.getByRole("button", { name: "Тёмная", exact: true }).click();
  await expect.poll(() => document.documentElement.classList.contains("dark")).toBe(true);
  await expect.poll(() => localStorage.getItem("theme")).toBe("dark");
  await first.unmount();
  await renderOnDesktop(<StatefulSettings />);
  await expect.element(page.getByRole("button", { name: "Тёмная", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Светлая", exact: true }).click();
  await expect.poll(() => document.documentElement.classList.contains("dark")).toBe(false);
  await expect.poll(() => localStorage.getItem("theme")).toBe("light");
  await page.getByRole("button", { name: "Системная", exact: true }).click();
  await commands.emulateColorScheme("dark");
  await expect.poll(() => document.documentElement.classList.contains("dark")).toBe(true);
  await commands.emulateColorScheme("light");
  await expect.poll(() => document.documentElement.classList.contains("dark")).toBe(false);
  await expect.poll(() => localStorage.getItem("theme")).toBe("system");
});

test("хук читает GET и сохраняет PATCH с сообщением валидации сервера", async () => {
  const fetch = vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(Response.json({ customInstructions: "Из GET", memoryEnabled: false }))
    .mockResolvedValueOnce(Response.json({ error: { code: "invalid_request", message: "Сообщение сервера." } }, { status: 400 }))
    .mockResolvedValueOnce(Response.json({ customInstructions: "Новые указания", memoryEnabled: false }));
  await renderOnDesktop(<NetworkSettings />);
  const field = page.getByRole("textbox");
  await expect.element(field).toHaveValue("Из GET");
  await field.fill("Новые указания");
  await page.getByRole("button", { name: "Сохранить" }).click();
  await expect.element(page.getByRole("alert")).toHaveTextContent("Сообщение сервера.");
  await page.getByRole("button", { name: "Сохранить" }).click();
  await expect.element(page.getByText("Сохранено", { exact: true })).toBeVisible();
  expect(fetch.mock.calls[0][0]).toBe("/api/settings");
  expect(fetch.mock.calls[1]).toEqual([
    "/api/settings",
    { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ customInstructions: "Новые указания" }) },
  ]);
});

test("поздний GET не затирает сохранённые изменения", async () => {
  const get = Promise.withResolvers<Response>();
  vi.spyOn(globalThis, "fetch")
    .mockImplementationOnce(() => get.promise)
    .mockResolvedValueOnce(Response.json({ customInstructions: "Новые указания", memoryEnabled: false }));
  await renderOnDesktop(<NetworkSettings />);
  await page.getByRole("textbox").fill("Новые указания");
  await page.getByRole("button", { name: "Сохранить" }).click();
  await expect.element(page.getByText("Сохранено", { exact: true })).toBeVisible();
  get.resolve(Response.json({ customInstructions: "Устаревшие указания", memoryEnabled: false }));
  await expect.element(page.getByRole("textbox")).toHaveValue("Новые указания");
});

for (const [viewport, renderSettings] of [
  ["телефон", renderOnPhone],
  ["компьютер", renderOnDesktop],
] as const) {
  for (const enabled of [false, true]) {
    test(`${viewport}: память ${enabled ? "включена" : "выключена"}, переключение доступно по подписи`, async () => {
      await renderSettings(<StatefulSettings initialMemoryEnabled={enabled} />);
      const toggle = page.getByRole("switch", { name: "Запоминать мои предпочтения", exact: true });
      await expect.element(toggle).toHaveAttribute("aria-checked", String(enabled));
      await expect.element(toggle).toHaveAttribute("aria-busy", "false");
      await expect.element(page.getByText(
        "Агент запоминает ваши постоянные предпочтения и использует их во всех ваших сессиях. Выключенная память не используется, но остаётся сохранённой. Просмотреть или очистить её нельзя.",
      )).toBeVisible();
      await expect.element(toggle).toHaveAccessibleDescription("Изменение действует со следующего сообщения.");
      await page.getByText("Запоминать мои предпочтения", { exact: true }).click();
      await expect.element(toggle).toHaveAttribute("aria-checked", String(!enabled));
      expectNoHorizontalScroll();
    });
  }

  test(`${viewport}: память изменяется оптимистически, блокирует повтор и сохраняется`, async () => {
    const pending = Promise.withResolvers<Settings>();
    const save = vi.fn(() => pending.promise);
    await renderSettings(<StatefulSettings save={save} />);
    const toggle = page.getByRole("switch", { name: "Запоминать мои предпочтения" });
    await toggle.click();
    await expect.element(toggle).toHaveAttribute("aria-checked", "true");
    await expect.element(toggle).toHaveAttribute("data-disabled");
    await expect.element(toggle).toHaveAttribute("aria-busy", "true");
    expect(save).toHaveBeenCalledExactlyOnceWith({ memoryEnabled: true });
    expectNoHorizontalScroll();

    pending.resolve({ customInstructions: "Пиши кратко.", memoryEnabled: true });
    await expect.element(toggle).toHaveAttribute("aria-busy", "false");
    await expect.element(toggle).toHaveAttribute("aria-checked", "true");
    expectNoHorizontalScroll();
  });

  for (const enabled of [false, true]) {
    test(`${viewport}: ошибка памяти откатывает ${enabled ? "выключение" : "включение"} и позволяет повтор`, async () => {
      const pending = Promise.withResolvers<Settings>();
      const save = vi.fn()
        .mockImplementationOnce(() => pending.promise)
        .mockResolvedValueOnce({ customInstructions: "Пиши кратко.", memoryEnabled: !enabled });
      await renderSettings(<StatefulSettings save={save} initialMemoryEnabled={enabled} />);
      const toggle = page.getByRole("switch", { name: "Запоминать мои предпочтения" });
      await toggle.click();
      await expect.element(toggle).toHaveAttribute("aria-checked", String(!enabled));
      pending.reject(new Error("private internal details"));

      await expect.element(page.getByRole("alert")).toHaveTextContent(
        "Не удалось изменить настройку памяти. Попробуйте ещё раз.",
      );
      await expect.element(toggle).toHaveAttribute("aria-checked", String(enabled));
      await expect.element(toggle).toHaveAttribute("aria-busy", "false");
      expectNoHorizontalScroll();

      await toggle.click();
      await expect.element(page.getByRole("alert")).not.toBeInTheDocument();
      await expect.element(toggle).toHaveAttribute("aria-busy", "false");
      await expect.element(toggle).toHaveAttribute("aria-checked", String(!enabled));
      expect(save).toHaveBeenNthCalledWith(2, { memoryEnabled: !enabled });
      expectNoHorizontalScroll();
    });
  }
}

test("память сохраняется через общий PATCH и не меняет общие указания", async () => {
  const fetch = vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(Response.json({ customInstructions: "Из GET", memoryEnabled: false }))
    .mockResolvedValueOnce(Response.json({ customInstructions: "Из GET", memoryEnabled: true }))
    .mockResolvedValueOnce(Response.json({ customInstructions: "Из GET", memoryEnabled: false }));
  await renderOnDesktop(<NetworkSettings />);
  const toggle = page.getByRole("switch", { name: "Запоминать мои предпочтения" });
  await expect.element(page.getByRole("textbox")).toHaveValue("Из GET");
  await toggle.click();
  await expect.element(toggle).toHaveAttribute("aria-busy", "false");
  await expect.element(toggle).toHaveAttribute("aria-checked", "true");
  await toggle.click();
  await expect.element(toggle).toHaveAttribute("aria-busy", "false");
  await expect.element(toggle).toHaveAttribute("aria-checked", "false");
  expect(fetch.mock.calls.slice(1)).toEqual([true, false].map((memoryEnabled) => [
    "/api/settings",
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ memoryEnabled }),
    },
  ]));
  await expect.element(page.getByRole("textbox")).toHaveValue("Из GET");
});
