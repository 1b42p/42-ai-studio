import type { MessageStreamEvent } from "eve/client";
import { conversationReducer, type ConversationState } from "eve/react";
import { expect, test } from "vitest";
import { page } from "vitest/browser";

import { AppShell } from "@/components/studio/app-shell";
import { ChatView } from "@/components/studio/chat/chat-view";
import { navItems } from "@/components/studio/nav";

import { simpleConversation } from "./fixtures/conversations";
import {
  expectNoHorizontalScroll,
  renderOnDesktop,
  renderOnPhone,
} from "./support/render";

function stateOf(events: readonly MessageStreamEvent[]): ConversationState {
  return events.reduce<ConversationState>(
    (state, event) => conversationReducer.reduce(state, event),
    conversationReducer.initial(),
  );
}

function chatPage(pathname: string, events: readonly MessageStreamEvent[] = []) {
  return (
    <AppShell navItems={navItems} pathname={pathname}>
      <div className="h-dvh">
        <ChatView
          agent={{ data: stateOf(events), events, status: "ready" }}
          onCancel={() => undefined}
          onRespond={() => undefined}
          onSend={() => undefined}
        />
      </div>
    </AppShell>
  );
}

test("новый чат /s приглашает описать ролик и показывает поле ввода", async () => {
  const phone = await renderOnPhone(chatPage("/s"));
  await expect
    .element(page.getByText("Опишите, какой ролик нужно сделать"))
    .toBeVisible();
  await expect
    .element(page.getByRole("textbox", { name: "Сообщение агенту" }))
    .toBeVisible();
  expectNoHorizontalScroll();
  await phone.unmount();

  await renderOnDesktop(chatPage("/s"));
  await expect
    .element(page.getByText("Опишите, какой ролик нужно сделать"))
    .toBeVisible();
  await expect
    .element(page.getByRole("textbox", { name: "Сообщение агенту" }))
    .toBeVisible();
});

test("беседа /s/[sessionId] не прокручивается по горизонтали на телефоне и компьютере", async () => {
  const phone = await renderOnPhone(
    chatPage("/s/00000000-0000-4000-8000-000000000000", simpleConversation),
  );
  await expect.element(page.getByText("Эхо: привет")).toBeVisible();
  expectNoHorizontalScroll();
  await phone.unmount();

  await renderOnDesktop(
    chatPage("/s/00000000-0000-4000-8000-000000000000", simpleConversation),
  );
  await expect.element(page.getByText("Эхо: привет")).toBeVisible();
  expectNoHorizontalScroll();
});
