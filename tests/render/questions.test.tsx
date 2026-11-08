import type { ConversationInput } from "eve/react";
import { afterEach, expect, test, vi } from "vitest";
import { page, userEvent } from "vitest/browser";

import { InputPrompt } from "@/components/studio/chat/input-prompt";
import { ChatView, type ChatViewProps } from "@/components/studio/chat/chat-view";
import type { AttachmentsController } from "@/components/studio/chat/attachments";
import { question, questionsState, sessionLimit } from "./fixtures/questions";
import { expectNoHorizontalScroll, renderOnDesktop, renderOnPhone } from "./support/render";

afterEach(() => vi.restoreAllMocks());

function view(inputs: ConversationInput[], props: Partial<ChatViewProps> = {}, inline = true) {
  return <div className="h-dvh"><ChatView
    agent={{ data: questionsState(inputs, inline), events: [], status: "streaming" }}
    onSend={vi.fn()} onRespond={vi.fn()} onCancel={vi.fn()} {...props} /></div>;
}

for (const [name, render] of [["телефон", renderOnPhone], ["компьютер", renderOnDesktop]] as const) {
  test(`${name}: состояния вопросов и длинный ответ не расширяют окно`, async () => {
    const base = question();
    const states = [
      base,
      question({ request: { ...base.request, options: undefined } }),
      question({ status: "responded", response: { requestId: base.request.requestId, text: "Ответ".repeat(100) } }),
      question({ status: "settled", outcome: "answered", response: { requestId: base.request.requestId, optionId: "vertical" } }),
      question({ status: "settled", outcome: "cancelled" }),
      question({ status: "settled", outcome: "ignored" }),
      question({ status: "settled", outcome: "approved" }), sessionLimit(),
    ];
    for (const input of states) {
      const q = { ...input, request: { ...input.request, options: input.request.options?.map((option) => ({ ...option, description: "Описание ".repeat(25) })) } };
      const screen = await render(<InputPrompt input={q} onRespond={vi.fn()} />);
      if (q.status === "responded") {
        await expect.element(page.getByText("Ответ отправлен")).toBeVisible();
        for (const control of document.querySelectorAll<HTMLButtonElement | HTMLTextAreaElement>("button, textarea")) expect(control.disabled).toBe(true);
      } else if (q.status === "settled") {
        await expect.element(page.getByRole("status")).toBeVisible();
        expect(document.querySelectorAll("button, textarea")).toHaveLength(0);
        if (q.outcome === "cancelled" || q.outcome === "ignored") await expect.element(page.getByText("Вопрос снят")).toBeVisible();
        if (q.outcome === "approved") await expect.element(page.getByText("Вопрос закрыт")).toBeVisible();
        if (q.outcome === "answered") await expect.element(page.getByText(/→ 9:16/)).toBeVisible();
      } else if (q.request.kind === "session-limit") {
        await expect.element(page.getByRole("button", { name: "Продолжить" })).toBeVisible();
        await expect.element(page.getByRole("button", { name: "Остановить" })).toBeVisible();
      } else {
        await expect.element(page.getByRole("textbox", { name: "Свой ответ" })).toBeVisible();
      }
      expect(document.body.textContent).not.toContain("ask_question");
      expect(document.body.textContent).not.toContain('"requestId"');
      expectNoHorizontalScroll();
      await screen.unmount();
    }
  });
}

test("варианты отвечают одним нажатием; Tab, Enter и Space работают", async () => {
  const onRespond = vi.fn();
  const q = question();
  await renderOnDesktop(<InputPrompt input={q} onRespond={onRespond} />);
  for (const [index, option] of q.request.options!.entries()) {
    const button = page.getByRole("button", { name: new RegExp(option.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) });
    if (index === 0) (document.activeElement as HTMLElement)?.blur();
    await userEvent.tab();
    await expect.element(button).toHaveFocus();
    await userEvent.keyboard(index === 1 ? " " : "{Enter}");
    await expect.poll(() => onRespond.mock.calls.length).toBe(index + 1);
    expect(onRespond).toHaveBeenLastCalledWith([{ requestId: q.request.requestId, optionId: option.id }]);
  }
});

test("свободный ответ: кнопка, Enter, Shift+Enter и сенсорная клавиатура", async () => {
  const onRespond = vi.fn();
  const q = question({ request: { ...question().request, options: undefined } });
  await renderOnDesktop(<InputPrompt input={q} onRespond={onRespond} />);
  const text = page.getByRole("textbox", { name: "Свой ответ" });
  await text.fill("  Кофе  ");
  await page.getByRole("button", { name: "Ответить" }).click();
  expect(onRespond).toHaveBeenLastCalledWith([{ requestId: q.request.requestId, text: "Кофе" }]);
  await userEvent.type(text, "{Shift>}{Enter}{/Shift}");
  expect(onRespond).toHaveBeenCalledTimes(1);
  await userEvent.keyboard("{Enter}");
  expect(onRespond).toHaveBeenCalledTimes(2);
  // Viewport alone does not change the host's pointer; emulate a touch keyboard.
  const original = window.matchMedia.bind(window);
  vi.spyOn(window, "matchMedia").mockImplementation((query) => query === "(pointer: coarse)"
    ? { ...original(query), matches: true } : original(query));
  await page.viewport(390, 844);
  await text.fill("Мобильный ответ");
  await userEvent.type(text, "{Enter}");
  expect(onRespond).toHaveBeenCalledTimes(2);
  await expect.element(text).toHaveValue("Мобильный ответ\n");
  await page.getByRole("button", { name: "Ответить" }).click();
  expect(onRespond).toHaveBeenLastCalledWith([{ requestId: q.request.requestId, text: "Мобильный ответ" }]);
});

test("вопрос из раннего хода рисуется у вызова один раз и отвечает через общее поле", async () => {
  const onRespond = vi.fn(); const onSend = vi.fn();
  await renderOnDesktop(view([question()], { onRespond, onSend }));
  expect(document.querySelectorAll('[data-slot="card"]')).toHaveLength(1);
  const before = page.getByText("Перед вопросом").element();
  const card = document.querySelector('[data-slot="card"]')!;
  const after = page.getByText("После вопроса").element();
  expect(before.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(card.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  const composer = page.getByRole("textbox", { name: "Сообщение агенту" });
  await expect.element(composer).toHaveAttribute("placeholder", "Ответьте на вопрос агента или напишите своё");
  await userEvent.type(composer, "Квадрат{Enter}");
  expect(onRespond).toHaveBeenCalledWith([{ requestId: "req_question", text: "Квадрат" }]);
  expect(onSend).not.toHaveBeenCalled();
});

test("вопрос копии закреплён над полем; лимит приоритетен и использует id запроса", async () => {
  const onRespond = vi.fn();
  await renderOnPhone(view([question({ taskId: "copy_task" }), sessionLimit()], { onRespond }));
  await expect.element(page.getByText("Вопрос от копии агента", { exact: true })).toBeVisible();
  const composer = page.getByRole("textbox", { name: "Сообщение агенту" });
  await expect.element(composer).toBeDisabled();
  await expect.element(composer).toHaveAttribute("placeholder", "Нажмите «Продолжить» или «Остановить»");
  const limit = page.getByText("Лимит сессии", { exact: true }).element();
  expect(limit.compareDocumentPosition(composer.element()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  await page.getByRole("button", { name: "Остановить", exact: true }).click();
  expect(onRespond).toHaveBeenCalledWith([{ requestId: "req_limit", optionId: "cancel" }]);
});

test("resuming блокирует все ответы, а отказ отправки позволяет повторить", async () => {
  const screen = await renderOnDesktop(view([question()], {
    agent: { data: questionsState([question()]), status: "resuming", events: [] },
  }));
  await expect.element(page.getByRole("button", { name: /^16:9/ })).toBeDisabled();
  await expect.element(page.getByRole("textbox", { name: "Свой ответ" })).toBeDisabled();
  await screen.unmount();
  const onRespond = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(undefined);
  await renderOnDesktop(<InputPrompt input={question()} onRespond={onRespond} />);
  await page.getByRole("button", { name: /^16:9/ }).click();
  await expect.element(page.getByText("Не удалось отправить ответ. Попробуйте ещё раз.")).toBeVisible();
  await page.getByRole("button", { name: /^16:9/ }).click();
  expect(onRespond).toHaveBeenCalledTimes(2);
});

test("вопрос без свободного ввода блокирует общее поле; подтверждение использует подписи запроса", async () => {
  const q = question({ request: { ...question().request, allowFreeform: false } });
  const screen = await renderOnDesktop(view([q]));
  await expect.element(page.getByRole("textbox", { name: "Сообщение агенту" })).toBeDisabled();
  await expect.element(page.getByRole("textbox", { name: "Сообщение агенту" })).toHaveAttribute("placeholder", "Выберите вариант выше");
  await expect.element(page.getByRole("textbox", { name: "Свой ответ" })).not.toBeInTheDocument();
  await screen.unmount();
  const onRespond = vi.fn();
  await renderOnDesktop(<InputPrompt input={question({ request: { ...q.request, kind: "tool-approval", options: [
    { id: "yes", label: "Разрешить" }, { id: "no", label: "Отказать", style: "danger" },
  ] } })} onRespond={onRespond} />);
  await page.getByRole("button", { name: "Разрешить" }).click();
  expect(onRespond).toHaveBeenCalledWith([{ requestId: "req_question", optionId: "yes" }]);
});

test("прикреплённый файл отправляется сообщением, а восстановленный ответ остаётся сводкой", async () => {
  const onSend = vi.fn(); const onRespond = vi.fn();
  const attachments: AttachmentsController = {
    blocking: false, addFiles: vi.fn(), remove: vi.fn(), retry: vi.fn(), clear: vi.fn(),
    items: [{ id: "file_1", name: "topic.txt", contentType: "text/plain", sizeBytes: 20, state: "done", progress: 100, fileUrl: "https://studio.test/api/media/1" }],
  };
  const screen = await renderOnDesktop(view([question()], { onSend, onRespond, attachments }));
  await userEvent.type(page.getByRole("textbox", { name: "Сообщение агенту" }), "Материал{Enter}");
  expect(onSend).toHaveBeenCalledWith([
    { type: "text", text: "Материал" }, { type: "file", data: "https://studio.test/api/media/1", mediaType: "text/plain", filename: "topic.txt" },
  ]);
  expect(onRespond).not.toHaveBeenCalled();
  await screen.unmount();
  await renderOnDesktop(view([question({ status: "settled", outcome: "answered", response: { requestId: "req_question", optionId: "wide" } })]));
  await expect.element(page.getByText("Какой формат кадра? → 16:9")).toBeVisible();
  await expect.element(page.getByRole("textbox", { name: "Свой ответ" })).not.toBeInTheDocument();
  expectNoHorizontalScroll();
});
