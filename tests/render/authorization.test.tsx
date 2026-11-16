import { expect, test, vi } from "vitest";
import { page } from "vitest/browser";
import { conversationReducer, type EveMessagePart } from "eve/react";

import { AuthorizationCard } from "@/components/studio/chat/authorization-card";
import { safeAuthorizationUrl } from "@/components/studio/chat/authorization-url";
import { ChatView } from "@/components/studio/chat/chat-view";
import { ToolCard } from "@/components/studio/chat/tool-card";
import { authorizationConversation } from "./fixtures/authorization";
import { expectNoHorizontalScroll, renderOnDesktop, renderOnPhone } from "./support/render";

type AuthorizationPart = Extract<EveMessagePart, { type: "authorization" }>;
const required: AuthorizationPart = {
  type: "authorization", state: "required", name: "mcp", displayName: "Мой сервер",
  description: "", stepIndex: 0, turnId: "turn_0", attemptId: "attempt",
  awaitsCallback: true, authorization: { url: "https://login.example.com/authorize" },
};

test.each([
  ["https://example.com/login", [], true],
  ["http://example.com/login", [], false],
  ["javascript:alert(1)", [], false],
  ["data:text/html,test", [], false],
  ["/relative", [], false],
  ["https://user:pass@example.com", [], false],
  ["http://127.0.0.1:59211/authorize", ["127.0.0.1:59211"], true],
  ["http://127.0.0.1:59212/authorize", ["127.0.0.1:59211"], false],
  ["http://127.0.0.1:59211.evil.com/authorize", ["127.0.0.1:59211"], false],
] as const)("безопасность ссылки %s", (url, hosts, allowed) => {
  expect(safeAuthorizationUrl(url, hosts) !== null).toBe(allowed);
});

for (const [label, render] of [["телефон", renderOnPhone], ["компьютер", renderOnDesktop]] as const) {
  test.each([
    ["pkce_unsupported", "Сервер авторизации не поддерживает безопасный вход (PKCE)"],
    ["registration_unsupported", "Сервер не поддерживает автоматическую регистрацию клиента"],
    ["resource_mismatch", "Сервер описал себя иначе, чем указан адрес"],
    ["discovery_failed", "Не удалось получить настройки входа сервера"],
    ["wrong_user", "Вход возможен только владельцу сервера"],
  ])(`${label}: отказ до открытия входа %s`, async (reason, text) => {
    await render(<ToolCard data={conversationReducer.initial()} part={{
      type: "dynamic-tool", toolName: "eve__tool", toolCallId: "connection",
      state: "output-error", input: {}, errorText: `${reason}: private-response`,
    }} />);
    await expect.element(page.getByText(`Не удалось подключиться. ${text}`)).toBeVisible();
    expect(document.body.innerText).not.toContain("private-response");
    expect(document.querySelector('[data-status="error"]')).not.toBeNull();
    expectNoHorizontalScroll();
  });

  test(`${label}: сохранённые события восстанавливают запрос вне Trace с активным полем`, async () => {
    const onSend = vi.fn();
    await render(<div className="h-dvh"><ChatView agent={authorizationConversation()}
      onCancel={vi.fn()} onRespond={vi.fn()} onSend={onSend} /></div>);
    await expect.element(page.getByText("Нужен вход в «Личный сервер»")).toBeVisible();
    const item = document.querySelector('[data-slot="item"]');
    expect(item?.closest('[data-slot="trace"]')).toBeNull();
    const input = page.getByRole("textbox");
    await expect.element(input).toBeEnabled();
    await input.fill("Продолжай без сервера");
    await page.getByRole("button", { name: "Отправить", exact: true }).click();
    expect(onSend).toHaveBeenCalledWith("Продолжай без сервера");
    expectNoHorizontalScroll();
  });

  test.each([
    ["authorized", "Вход в «Личный сервер» выполнен", false],
    ["declined", "Вход в «Личный сервер» отменён", false],
    ["timed-out", "Время ожидания входа истекло. Попросите агента повторить", true],
  ] as const)(`${label}: завершение %s из истории`, async (outcome, text, failed) => {
    await render(<div className="h-dvh"><ChatView agent={authorizationConversation(outcome)}
      onCancel={vi.fn()} onRespond={vi.fn()} onSend={vi.fn()} /></div>);
    await expect.element(page.getByText(text, { exact: true })).toBeVisible();
    const line = document.querySelector('[data-slot="trace-line"]');
    expect(line?.closest('[data-slot="trace"]')).not.toBeNull();
    expect(line?.getAttribute("data-status")).toBe(failed ? "error" : null);
    expect(document.querySelector("a[target='_blank']")).toBeNull();
    expectNoHorizontalScroll();
  });

  test.each([
    ["access_denied", "Доступ не разрешён"],
    ["invalid_state", "Вход устарел, начните заново"],
    ["issuer_mismatch", "Ответ пришёл не от сервера авторизации"],
    ["pkce_unsupported", "Сервер авторизации не поддерживает безопасный вход (PKCE)"],
    ["registration_unsupported", "Сервер не поддерживает автоматическую регистрацию клиента"],
    ["resource_mismatch", "Сервер описал себя иначе, чем указан адрес"],
    ["discovery_failed", "Не удалось получить настройки входа сервера"],
    ["token_exchange_failed", "Сервер не выдал токен"],
    ["wrong_user", "Вход возможен только владельцу сервера"],
    ["unknown", "Попробуйте ещё раз"],
  ])(`${label}: причина отказа %s`, async (reason, text) => {
    await render(<div className="h-dvh"><ChatView agent={authorizationConversation("failed", reason)}
      onCancel={vi.fn()} onRespond={vi.fn()} onSend={vi.fn()} /></div>);
    await expect.element(page.getByText(`Не удалось войти в «Личный сервер». ${text}`, { exact: true })).toBeVisible();
    expect(document.querySelector('[data-status="error"]')).not.toBeNull();
    expectNoHorizontalScroll();
  });

  test(`${label}: вход и длинные подписи`, async () => {
    const name = "ДлинноеНазвание".repeat(40);
    const url = `https://${"host.".repeat(35)}example.com/authorize`;
    await render(<AuthorizationCard part={{ ...required, displayName: name, authorization: { url } }} />);
    const link = page.getByRole("button", { name: "Войти", exact: true });
    await expect.element(link).toHaveAttribute("href", url);
    await expect.element(link).toHaveAttribute("target", "_blank");
    await expect.element(link).toHaveAttribute("rel", "noopener noreferrer");
    await expect.element(page.getByText("После входа закройте открывшуюся вкладку и вернитесь в чат")).toBeVisible();
    expectNoHorizontalScroll();
  });

  test(`${label}: небезопасная ссылка недоступна`, async () => {
    await render(<AuthorizationCard part={{ ...required, authorization: { url: "http://unsafe.example" } }} />);
    await expect.element(page.getByText("Ссылка для входа недоступна")).toBeVisible();
    expect(document.querySelector("a")).toBeNull();
  });

  test(`${label}: разрешённый сервером тестовый HTTP адрес`, async () => {
    const url = "http://127.0.0.1:59211/authorize";
    await render(<AuthorizationCard allowHosts={["127.0.0.1:59211"]}
      part={{ ...required, authorization: { url } }} />);
    await expect.element(page.getByRole("button", { name: "Войти", exact: true })).toHaveAttribute("href", url);
    expectNoHorizontalScroll();
  });
}
