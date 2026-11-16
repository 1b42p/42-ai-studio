import { expect, test, vi } from "vitest";
import { page } from "vitest/browser";

import { McpContext, type McpState } from "@/components/studio/settings/mcp-context";
import { McpSection } from "@/components/studio/settings/mcp-section";

import { expectNoHorizontalScroll, renderOnDesktop, renderOnPhone } from "./support/render";

const state: McpState = {
  servers: [{
    id: "a", name: "Тестовый сервер", url: `https://${"a".repeat(200)}.example/mcp`,
    authKind: "bearer", enabled: true, headerNames: [], createdAt: "",
  }],
  checks: { a: { ok: true, toolCount: 1, tools: ["echo"] } },
  add: vi.fn(), toggle: vi.fn(), remove: vi.fn(), check: vi.fn(),
};

for (const [label, render] of [["телефон", renderOnPhone], ["компьютер", renderOnDesktop]] as const) {
  test(`${label}: сервер и диалог подключения`, async () => {
    await render(<McpContext.Provider value={state}><McpSection /></McpContext.Provider>);
    await expect.element(page.getByText("Тестовый сервер")).toBeVisible();
    await expect.element(page.getByText(/Подключение работает/)).toBeVisible();
    await page.getByRole("button", { name: "Добавить сервер" }).click();
    await expect.element(page.getByRole("dialog")).toBeVisible();
    await expect.element(page.getByRole("textbox", { name: "Название" })).toBeVisible();
    expectNoHorizontalScroll();
  });
}

test("пустой список, выбор авторизации и управление заголовками", async () => {
  await renderOnPhone(<McpContext.Provider value={{ ...state, servers: [], checks: {} }}><McpSection /></McpContext.Provider>);
  await expect.element(page.getByText("Серверов пока нет")).toBeVisible();
  await page.getByRole("button", { name: "Добавить сервер" }).click();
  await page.getByRole("combobox").click();
  await page.getByRole("option", { name: "Свои заголовки" }).click();
  await expect.element(page.getByRole("textbox", { name: "Имя заголовка 1" })).toBeVisible();
  await page.getByRole("button", { name: "Добавить заголовок" }).click();
  await expect.element(page.getByRole("textbox", { name: "Имя заголовка 2" })).toBeVisible();
  await page.getByRole("button", { name: "Убрать заголовок 2" }).click();
  await expect.element(page.getByRole("textbox", { name: "Имя заголовка 2" })).not.toBeInTheDocument();
  expectNoHorizontalScroll();
});

test("удаление запрашивает подтверждение", async () => {
  const remove = vi.fn(async () => {});
  await renderOnDesktop(<McpContext.Provider value={{ ...state, remove }}><McpSection /></McpContext.Provider>);
  await page.getByRole("button", { name: "Удалить Тестовый сервер" }).click();
  await expect.element(page.getByRole("alertdialog")).toBeVisible();
  expect(remove).not.toHaveBeenCalled();
  await page.getByRole("button", { name: "Удалить", exact: true }).click();
  expect(remove).toHaveBeenCalledWith("a");
});

test.each([
  "Адрес сервера указывает во внутреннюю сеть. Подключение запрещено.",
  "Имя сервера не найдено.",
  "Сервер недоступен.",
  "Сервер не ответил за 15 секунд.",
  "Сервер перенаправляет запросы на example.com. Укажите конечный адрес.",
  "Сервер отказал в доступе. Проверьте токен или заголовки.",
  "Доступ запрещён сервером.",
  "Ответ не похож на ответ MCP-сервера.",
  "Ответ сервера слишком большой.",
  "Не удалось проверить сертификат сервера.",
])("показывает причину неудачной проверки: %s", async (message) => {
  const errorState: McpState = { ...state, checks: { a: { ok: false, reason: "error", message } } };
  await renderOnPhone(<McpContext.Provider value={errorState}><McpSection /></McpContext.Provider>);
  await expect.element(page.getByText(message)).toBeVisible();
  expectNoHorizontalScroll();
});
