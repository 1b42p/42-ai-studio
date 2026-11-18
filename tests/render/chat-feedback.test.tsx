import { beforeEach, afterEach, expect, test, vi } from "vitest";
import { page } from "vitest/browser";
import { conversationReducer } from "eve/react";

import { ChatComposer, ChatDraftIdentityContext } from "@/components/studio/chat/chat-composer";
import type { AttachmentsController } from "@/components/studio/chat/attachments";
import { ChatView } from "@/components/studio/chat/chat-view";
import { ThemeProvider } from "@/components/studio/theme-provider";
import {
  InputGroup, InputGroupInput, InputGroupTextarea, InputGroupAddon, InputGroupButton,
} from "@/components/ui/input-group";
import { renderOnDesktop, renderOnPhone } from "./support/render";

beforeEach(() => sessionStorage.clear());
afterEach(() => vi.restoreAllMocks());

function composer({
  user = "user-a",
  session = "session-a",
  onSend = vi.fn(async () => {}),
  attachments,
}: {
  user?: string | null;
  session?: string | null;
  onSend?: (content: unknown) => Promise<void>;
  attachments?: AttachmentsController;
} = {}) {
  return (
    <ChatDraftIdentityContext.Provider value={user}>
      <ChatComposer appSessionId={session} status="ready" onCancel={vi.fn()} onSend={onSend} attachments={attachments} />
    </ChatDraftIdentityContext.Provider>
  );
}

for (const [name, render] of [["телефон", renderOnPhone], ["компьютер", renderOnDesktop]] as const) {
  test(`${name}: выключенная кнопка не приглушает доступное поле`, async () => {
    await render(
      <>
        <InputGroup aria-label="Доступная группа">
          <InputGroupTextarea aria-label="Доступный текст" />
          <InputGroupAddon align="block-end"><InputGroupButton disabled>Отправить</InputGroupButton></InputGroupAddon>
        </InputGroup>
        <InputGroup aria-label="Выключенная строка"><InputGroupInput aria-label="Строка" disabled /></InputGroup>
        <InputGroup aria-label="Выключенный текст"><InputGroupTextarea aria-label="Текст" disabled /></InputGroup>
      </>,
    );
    expect(getComputedStyle(page.getByRole("group", { name: "Доступная группа" }).element()).opacity).toBe("1");
    expect(getComputedStyle(page.getByRole("group", { name: "Выключенная строка" }).element()).opacity).toBe("0.5");
    expect(getComputedStyle(page.getByRole("group", { name: "Выключенный текст" }).element()).opacity).toBe("0.5");
  });
}

test("непринятая отправка сохраняет исходный текст и вложения, повтор очищает только после успеха", async () => {
  const pending = Promise.withResolvers<void>();
  const onSend = vi.fn().mockRejectedValueOnce(new TypeError("offline")).mockImplementationOnce(() => pending.promise);
  const attachments: AttachmentsController = {
    items: [{ id: "file", name: "script.txt", contentType: "text/plain", sizeBytes: 10, state: "done", progress: 100, fileUrl: "/api/media/test" }],
    blocking: false, addFiles: vi.fn(), remove: vi.fn(), retry: vi.fn(), clear: vi.fn(),
  };
  await renderOnPhone(composer({ onSend, attachments }));
  const field = page.getByRole("textbox", { name: "Сообщение агенту" });
  await field.fill("  Мой ролик  ");
  await page.getByRole("button", { name: "Отправить", exact: true }).click();
  await expect.poll(() => page.getByRole("alert").element().textContent?.replace(/\s+/g, " ").trim()).toContain("Попробуйте ещё раз");
  await expect.element(field).toHaveValue("  Мой ролик  ");
  expect(attachments.clear).not.toHaveBeenCalled();
  expect(sessionStorage.getItem("studio:draft:v1:user-a:chat:session-a")).toBe("  Мой ролик  ");
  expect(JSON.stringify(sessionStorage)).not.toContain("script.txt");

  await page.getByRole("button", { name: "Отправить", exact: true }).click();
  await expect.element(field).toBeEnabled();
  await expect.element(page.getByRole("button", { name: "Отправить", exact: true })).toBeDisabled();
  field.element().closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  expect(onSend).toHaveBeenCalledTimes(2);
  expect(attachments.clear).not.toHaveBeenCalled();
  pending.resolve();
  await expect.poll(() => vi.mocked(attachments.clear).mock.calls.length).toBe(1);
  await expect.element(field).toHaveValue("");
  expect(attachments.clear).toHaveBeenCalledTimes(1);
  expect(sessionStorage.getItem("studio:draft:v1:user-a:chat:session-a")).toBeNull();
});

test("черновики восстанавливаются после навигации и разделены по пользователю и сессии", async () => {
  let view = await renderOnDesktop(composer());
  await page.getByRole("textbox").fill("Первый черновик");
  await view.unmount();
  view = await renderOnDesktop(composer({ session: "session-b" }));
  await expect.element(page.getByRole("textbox")).toHaveValue("");
  await page.getByRole("textbox").fill("Второй черновик");
  await view.unmount();
  view = await renderOnDesktop(composer({ user: "user-b" }));
  await expect.element(page.getByRole("textbox")).toHaveValue("");
  await view.unmount();
  await renderOnDesktop(composer());
  await expect.element(page.getByRole("textbox")).toHaveValue("Первый черновик");
});

test("вложение, добавленное во время ожидания принятия, не очищается вместе с отправленным", async () => {
  const pending = Promise.withResolvers<void>();
  const onSend = vi.fn(() => pending.promise);
  const attachments: AttachmentsController = {
    items: [{ id: "sent", name: "sent.txt", contentType: "text/plain", sizeBytes: 1, state: "done", progress: 100, fileUrl: "/api/media/sent" }],
    blocking: false, addFiles: vi.fn(), remove: vi.fn(), retry: vi.fn(), clear: vi.fn(),
  };
  const view = await renderOnDesktop(composer({ attachments, onSend }));
  await page.getByRole("button", { name: "Отправить", exact: true }).click();
  const added = {
    ...attachments,
    items: [...attachments.items, { ...attachments.items[0], id: "new", name: "new.txt" }],
  };
  await view.rerender(<ThemeProvider>{composer({ attachments: added, onSend })}</ThemeProvider>);
  pending.resolve();
  await expect.poll(() => vi.mocked(attachments.remove).mock.calls.length).toBe(1);
  expect(attachments.clear).not.toHaveBeenCalled();
  expect(attachments.remove).toHaveBeenCalledExactlyOnceWith("sent");
});

test("первая сессия переносит черновик с new на полученный ID до подтверждения отправки", async () => {
  const view = await renderOnDesktop(composer({ session: null }));
  await page.getByRole("textbox").fill("Черновик нового ролика");
  await view.rerender(<ThemeProvider>{composer({ session: "created-session" })}</ThemeProvider>);
  await expect.element(page.getByRole("textbox")).toHaveValue("Черновик нового ролика");
  expect(sessionStorage.getItem("studio:draft:v1:user-a:chat:new")).toBeNull();
  expect(sessionStorage.getItem("studio:draft:v1:user-a:chat:created-session")).toBe("Черновик нового ролика");
});

test("принятая отправка существующей беседы не удаляет независимый chat:new", async () => {
  sessionStorage.setItem("studio:draft:v1:user-a:chat:new", "Независимый новый ролик");
  await renderOnDesktop(composer());
  await page.getByRole("textbox").fill("Сообщение существующей беседы");
  await page.getByRole("button", { name: "Отправить", exact: true }).click();
  await expect.element(page.getByRole("textbox")).toHaveValue("");
  expect(sessionStorage.getItem("studio:draft:v1:user-a:chat:new")).toBe("Независимый новый ролик");
});

test("ACK мигрировавшего new не очищает новый независимый черновик по прежнему ключу", async () => {
  const pending = Promise.withResolvers<void>();
  const onSend = vi.fn(() => pending.promise);
  const view = await renderOnDesktop(composer({ session: null, onSend }));
  await page.getByRole("textbox").fill("Первое сообщение");
  await page.getByRole("button", { name: "Отправить", exact: true }).click();
  await view.rerender(<ThemeProvider>{composer({ session: "created-session", onSend })}</ThemeProvider>);
  sessionStorage.setItem("studio:draft:v1:user-a:chat:new", "Другой новый ролик");
  sessionStorage.setItem("studio:draft:v1:user-a:chat:new:pending", "Другая неподтверждённая отправка");
  pending.resolve();
  await expect.element(page.getByRole("textbox")).toHaveValue("");
  expect(sessionStorage.getItem("studio:draft:v1:user-a:chat:created-session")).toBeNull();
  expect(sessionStorage.getItem("studio:draft:v1:user-a:chat:new")).toBe("Другой новый ролик");
  expect(sessionStorage.getItem("studio:draft:v1:user-a:chat:new:pending")).toBe("Другая неподтверждённая отправка");
});

test("позднее подтверждение не стирает текст, изменённый после снимка отправки", async () => {
  const pending = Promise.withResolvers<void>();
  const onSend = vi.fn(() => pending.promise);
  await renderOnDesktop(composer({ onSend }));
  const field = page.getByRole("textbox");
  await field.fill("Отправленный текст");
  await page.getByRole("button", { name: "Отправить", exact: true }).click();
  // Cover a value update that races with the ACK, even while the DOM is disabled.
  const node = field.element() as HTMLTextAreaElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  setter.call(node, "Уже следующий текст");
  node.dispatchEvent(new Event("input", { bubbles: true }));
  pending.resolve();
  await expect.element(field).toBeEnabled();
  await expect.element(field).toHaveValue("Уже следующий текст");
  expect(sessionStorage.getItem("studio:draft:v1:user-a:chat:session-a")).toBe("Уже следующий текст");
});

test("поздний успех отправки прежнего пользователя не очищает чужой черновик", async () => {
  const pending = Promise.withResolvers<void>();
  const onSend = vi.fn(() => pending.promise);
  sessionStorage.setItem("studio:draft:v1:user-b:chat:session-a", "Черновик другого пользователя");
  const view = await renderOnDesktop(composer({ onSend }));
  await page.getByRole("textbox").fill("Отправленный текст");
  await page.getByRole("button", { name: "Отправить", exact: true }).click();
  await view.rerender(<ThemeProvider>{composer({ user: "user-b", onSend })}</ThemeProvider>);
  await expect.element(page.getByRole("textbox")).toHaveValue("Черновик другого пользователя");
  pending.resolve();
  await expect.element(page.getByRole("textbox")).toBeEnabled();
  await expect.element(page.getByRole("textbox")).toHaveValue("Черновик другого пользователя");
  expect(sessionStorage.getItem("studio:draft:v1:user-b:chat:session-a")).toBe("Черновик другого пользователя");
  expect(sessionStorage.getItem("studio:draft:v1:user-a:chat:session-a")).toBeNull();
});

test("без безопасной identity текст не хранится и уход требует подтверждения", async () => {
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  await renderOnDesktop(<>{composer({ user: null })}<a href="/settings">Настройки</a></>);
  await page.getByRole("textbox").fill("Несохранённое задание");
  await page.getByRole("link", { name: "Настройки" }).click();
  expect(confirm).toHaveBeenCalledTimes(1);
  expect(sessionStorage.length).toBe(0);
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
});

test("при отказе sessionStorage текст остаётся доступным и включается предупреждение", async () => {
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("Quota", "QuotaExceededError"); });
  await renderOnDesktop(composer());
  await page.getByRole("textbox").fill("Не терять этот текст");
  await expect.element(page.getByRole("textbox")).toHaveValue("Не терять этот текст");
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
});

test("ошибка первого запроса видна у редактора даже со списком сессий", async () => {
  await renderOnPhone(
    <ChatView
      agent={{ data: conversationReducer.initial(), events: [], status: "ready", error: new Error("Не удалось создать сессию. Попробуйте ещё раз.") }}
      sessions={<p>Медиатека</p>}
      onSend={vi.fn()} onRespond={vi.fn()} onCancel={vi.fn()}
    />,
  );
  await expect.poll(() => page.getByRole("alert").element().textContent?.replace(/\s+/g, " ").trim()).toContain("Не удалось создать сессию");
  await expect.element(page.getByRole("textbox")).toBeVisible();
  await expect.element(page.getByRole("link", { name: "Новая сессия" })).toHaveAttribute("href", "/s");
});
