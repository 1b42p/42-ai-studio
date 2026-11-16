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
  add: vi.fn(), toggle: vi.fn(), remove: vi.fn(), check: vi.fn(), signout: vi.fn(),
};

for (const [label, render] of [["телефон", renderOnPhone], ["компьютер", renderOnDesktop]] as const) {
  test(`${label}: OAuth, статус и подтверждение сброса`, async () => {
    const signout = vi.fn(async () => {});
    await render(<McpContext.Provider value={{
      ...state, signout, servers: [
        { ...state.servers[0], authKind: "oauth", connected: true },
        { ...state.servers[0], id: "b", name: "ДлинноеНазвание".repeat(40), authKind: "oauth", connected: false },
      ],
    }}><McpSection /></McpContext.Provider>);
    await expect.element(page.getByText("Подключён", { exact: true })).toBeVisible();
    await expect.element(page.getByText("Не подключён", { exact: true })).toBeVisible();
    expectNoHorizontalScroll();
    await page.getByRole("button", { name: "Сбросить вход: Тестовый сервер", exact: true }).click();
    await expect.element(page.getByRole("alertdialog")).toBeVisible();
    expect(signout).not.toHaveBeenCalled();
    await page.getByRole("button", { name: "Сбросить вход", exact: true }).click();
    expect(signout).toHaveBeenCalledWith("a");
  });

  test(`${label}: добавление OAuth не отправляет сохранённые поля токена`, async () => {
    const add = vi.fn(async () => {});
    await render(<McpContext.Provider value={{ ...state, add }}><McpSection /></McpContext.Provider>);
    await page.getByRole("button", { name: "Добавить сервер" }).click();
    await page.getByRole("combobox").click();
    await page.getByRole("option", { name: "Токен (Bearer)" }).click();
    const input = document.querySelector<HTMLInputElement>("#mcp-token");
    expect(input).not.toBeNull();
    await page.getByLabelText("Токен", { exact: true }).fill("previous-secret");
    await page.getByRole("combobox").click();
    await page.getByRole("option", { name: "Вход через браузер (OAuth)" }).click();
    expect(document.querySelector("#mcp-token")).toBeNull();
    await expect.element(page.getByText("Вход выполнится в чате, когда агент впервые обратится к серверу")).toBeVisible();
    await page.getByRole("button", { name: "Добавить", exact: true }).click();
    expect(add).toHaveBeenCalledWith({ name: "", url: "", authKind: "oauth" });
  });

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

test("сброс входа: отмена не вызывает обработчик, ошибка сохраняет подключение", async () => {
  const signout = vi.fn(async () => { throw new Error("Не удалось сбросить вход."); });
  await renderOnPhone(<McpContext.Provider value={{
    ...state, signout, servers: [{ ...state.servers[0], authKind: "oauth", connected: true }],
  }}><McpSection /></McpContext.Provider>);
  const trigger = page.getByRole("button", { name: "Сбросить вход: Тестовый сервер", exact: true });
  await trigger.click();
  await page.getByRole("button", { name: "Отмена", exact: true }).click();
  expect(signout).not.toHaveBeenCalled();
  await trigger.click();
  await page.getByRole("button", { name: "Сбросить вход", exact: true }).click();
  await expect.element(page.getByRole("alertdialog").getByText("Не удалось сбросить вход.")).toBeVisible();
  await expect.element(page.getByRole("alertdialog")).toBeVisible();
});

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
  await page.getByRole("combobox").click();
  await page.getByRole("option", { name: "Токен (Bearer)" }).click();
  const token = document.querySelector<HTMLInputElement>("#mcp-token");
  expect(token?.type).toBe("password");
  await page.getByRole("combobox").click();
  await page.getByRole("option", { name: "Без авторизации" }).click();
  expect(document.querySelector("#mcp-token")).toBeNull();
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

test("три способа входа и управление сервером", async () => {
  const toggle = vi.fn(async () => {});
  const check = vi.fn(async () => {});
  const servers: McpState["servers"] = [
    { ...state.servers[0], id: "none", name: "Открытый", authKind: "none" },
    { ...state.servers[0], id: "bearer", name: "С токеном", authKind: "bearer" },
    { ...state.servers[0], id: "headers", name: "С заголовком", authKind: "headers", headerNames: ["x-api-key"] },
  ];
  await renderOnDesktop(<McpContext.Provider value={{ ...state, servers, toggle, check }}><McpSection /></McpContext.Provider>);
  for (const label of ["Без авторизации", "Токен", "Заголовки"]) {
    await expect.element(page.getByText(label, { exact: true })).toBeVisible();
  }
  await page.getByRole("switch", { name: "Включён: Открытый" }).click();
  expect(toggle).toHaveBeenCalledWith("none", false);
  await page.getByRole("button", { name: "Проверить С токеном" }).click();
  expect(check).toHaveBeenCalledWith("bearer");
  expect(document.body.textContent).not.toContain("secret-token");
  expectNoHorizontalScroll();
});

test("ошибка добавления показывается под полем", async () => {
  const add = vi.fn(async () => { throw new Error("Укажите название сервера (до 60 символов)."); });
  await renderOnPhone(<McpContext.Provider value={{ ...state, servers: [], add }}><McpSection /></McpContext.Provider>);
  await page.getByRole("button", { name: "Добавить сервер" }).click();
  await page.getByRole("button", { name: "Добавить", exact: true }).click();
  await expect.element(page.getByText("Укажите название сервера (до 60 символов).")).toBeVisible();
  await expect.element(page.getByRole("textbox", { name: "Название" })).toHaveAttribute("aria-invalid", "true");
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
