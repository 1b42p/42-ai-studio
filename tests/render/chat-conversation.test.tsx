/** Экран беседы: лента, размышление, инструменты, вопросы, ошибки и поле ввода. */
import type { MessageStreamEvent } from "eve/client";
import { conversationReducer, type ConversationState } from "eve/react";
import { expect, test, vi } from "vitest";
import { page, userEvent } from "vitest/browser";

import { ChatPanel, type ChatAgent } from "@/components/studio/chat/chat-panel";
import { ChatView, type ChatViewProps } from "@/components/studio/chat/chat-view";

import {
  cancelledConversation,
  completedConversation,
  failedConversation,
  questionConversation,
  reasoningConversation,
  simpleConversation,
  toolConversation,
  wideContentConversation,
} from "./fixtures/conversations";
import { expectNoHorizontalScroll, renderOnDesktop, renderOnPhone } from "./support/render";

function stateOf(events: readonly MessageStreamEvent[]): ConversationState {
  return events.reduce<ConversationState>(
    (state, event) => conversationReducer.reduce(state, event),
    conversationReducer.initial(),
  );
}

function view(
  events: readonly MessageStreamEvent[],
  props: Partial<Omit<ChatViewProps, "agent">> & {
    status?: ChatViewProps["agent"]["status"];
  } = {},
) {
  const { status = "ready", ...rest } = props;

  return (
    <div className="h-dvh">
      <ChatView
        agent={{ data: stateOf(events), events, status }}
        onCancel={vi.fn()}
        onRespond={vi.fn()}
        onSend={vi.fn()}
        {...rest}
      />
    </div>
  );
}

function fakeAgent(events: readonly MessageStreamEvent[], status: ChatViewProps["agent"]["status"]) {
  return {
    cancel: vi.fn(async () => ({ status: "accepted" })),
    data: stateOf(events),
    error: undefined,
    events,
    respond: vi.fn(async () => undefined),
    send: vi.fn(async () => undefined),
    status,
  } as unknown as ChatAgent;
}

test("простая беседа показывает вопрос и ответ на телефоне и компьютере", async () => {
  const phone = await renderOnPhone(view(simpleConversation));
  await expect.element(page.getByText("привет")).toBeVisible();
  await expect.element(page.getByText("Эхо: привет")).toBeVisible();
  expectNoHorizontalScroll();
  await phone.unmount();

  await renderOnDesktop(view(simpleConversation));
  await expect.element(page.getByText("Эхо: привет")).toBeVisible();
  expectNoHorizontalScroll();
});

test("размышление свёрнуто в строку и раскрывается по клику", async () => {
  await renderOnDesktop(view(reasoningConversation()));

  const trigger = page.getByRole("button", { name: /Размышление/ });
  await expect.element(trigger).toBeVisible();
  await expect
    .element(page.getByText("Сначала выясню тему и длительность."))
    .not.toBeInTheDocument();

  await trigger.click();

  await expect
    .element(page.getByText("Сначала выясню тему и длительность."))
    .toBeVisible();
});

test("вызов инструмента показан подписью без имени, входа и результата", async () => {
  await renderOnDesktop(view(toolConversation()));

  await expect.element(page.getByText("Проверяет папку")).toBeVisible();
  await expect.element(page.getByText("bash")).not.toBeInTheDocument();
  await expect.element(page.getByText("ls")).not.toBeInTheDocument();
  await expect.element(page.getByText("секретный-вывод")).not.toBeInTheDocument();
});

test("открытый вопрос отвечает вариантом и своим текстом с requestId", async () => {
  const onRespond = vi.fn();
  await renderOnDesktop(view(questionConversation(), { onRespond }));

  await expect.element(page.getByText("Какой стиль выбрать?")).toBeVisible();
  await page.getByRole("button", { name: /Ретро/ }).click();
  expect(onRespond).toHaveBeenCalledWith([{ optionId: "retro", requestId: "req_1" }]);

  await page.getByRole("textbox", { name: "Свой ответ" }).fill("Свой вариант");
  await page.getByRole("button", { name: "Ответить" }).click();
  expect(onRespond).toHaveBeenCalledWith([{ requestId: "req_1", text: "Свой вариант" }]);
});

test("ошибка MODEL_CALL_FAILED объяснена по-русски", async () => {
  await renderOnDesktop(view(failedConversation()));

  await expect.element(page.getByText("Не удалось получить ответ")).toBeVisible();
  await expect
    .element(page.getByText("Модель сейчас недоступна. Попробуйте ещё раз."))
    .toBeVisible();
});

test("отменённый ход помечен «Остановлено»", async () => {
  await renderOnDesktop(view(cancelledConversation()));

  await expect.element(page.getByText("Остановлено")).toBeVisible();
});

test("завершённая сессия скрывает поле ввода и предлагает новую", async () => {
  await renderOnDesktop(view(completedConversation()));

  await expect.element(page.getByText("Сессия завершена")).toBeVisible();
  await expect
    .element(page.getByRole("textbox", { name: "Сообщение агенту" }))
    .not.toBeInTheDocument();
  await expect
    .element(page.getByRole("button", { name: "Новая сессия" }).first())
    .toBeVisible();
});

test("состояние resuming блокирует поле ввода", async () => {
  await renderOnDesktop(view(simpleConversation, { status: "resuming" }));

  const textarea = page.getByRole("textbox", { name: "Сообщение агенту" });
  await expect.element(textarea).toBeDisabled();
  await expect.element(textarea).toHaveAttribute("placeholder", "Восстанавливаем беседу…");
});

test("широкий ответ не даёт горизонтальной прокрутки", async () => {
  const phone = await renderOnPhone(view(wideContentConversation()));
  await expect.element(page.getByText("ts", { exact: true })).toBeVisible();
  expectNoHorizontalScroll();
  await phone.unmount();

  await renderOnDesktop(view(wideContentConversation()));
  await expect.element(page.getByText("ts", { exact: true })).toBeVisible();
  expectNoHorizontalScroll();
});

test("«Стоп» видна только во время хода", async () => {
  const submitted = await renderOnDesktop(view(simpleConversation, { status: "submitted" }));
  await expect.element(page.getByRole("button", { name: "Стоп" })).toBeVisible();
  await submitted.unmount();

  const streaming = await renderOnDesktop(view(simpleConversation, { status: "streaming" }));
  await expect.element(page.getByRole("button", { name: "Стоп" })).toBeVisible();
  await streaming.unmount();

  await renderOnDesktop(view(simpleConversation, { status: "ready" }));
  await expect
    .element(page.getByRole("button", { name: "Стоп" }))
    .not.toBeInTheDocument();
});

test("во время хода отправка вызывает обработчик с политикой steer", async () => {
  const agent = fakeAgent(simpleConversation, "streaming");
  await renderOnDesktop(<div className="h-dvh"><ChatPanel agent={agent} /></div>);

  await userEvent.type(page.getByRole("textbox", { name: "Сообщение агенту" }), "поправка{Enter}");

  expect(agent.send).toHaveBeenCalledWith("поправка", { turnPolicy: "steer" });
});

test("в шапке беседы есть «Новая сессия» со ссылкой на /s", async () => {
  await renderOnDesktop(view(simpleConversation));

  await expect.element(page.getByRole("button", { name: "Новая сессия" })).toHaveAttribute(
    "href",
    "/s",
  );
});

test("пустой новый чат приглашает описать ролик и показывает поле ввода", async () => {
  await renderOnPhone(view([], { emptyTitle: "Опишите, какой ролик нужно сделать" }));

  await expect
    .element(page.getByText("Опишите, какой ролик нужно сделать"))
    .toBeVisible();
  await expect.element(page.getByRole("textbox", { name: "Сообщение агенту" })).toBeVisible();
  expectNoHorizontalScroll();
});
