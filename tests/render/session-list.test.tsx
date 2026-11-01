/**
 * Список сессий на `/s`: ссылки, даты, поиск и раскладка. Даты заданы
 * литералами для фиксированного момента и пояса — так видно, что именно
 * нарисовал браузер.
 */
import type { MessageStreamEvent } from "eve/client";
import { conversationReducer, type ConversationState } from "eve/react";
import { useState } from "react";
import { expect, test } from "vitest";
import { page } from "vitest/browser";

import { ChatPanel, type ChatAgent } from "@/components/studio/chat/chat-panel";
import { ChatView } from "@/components/studio/chat/chat-view";
import {
  SessionList,
  type SessionListItem,
  type SessionListPage,
  type SessionListQuery,
} from "@/components/studio/sessions/session-list";
import { formatSessionDate } from "@/lib/sessions/format-date";

import { simpleConversation } from "./fixtures/conversations";
import { expectNoHorizontalScroll, renderOnDesktop, renderOnPhone } from "./support/render";

const NOW = new Date("2026-11-01T12:00:00Z");
const ZONE = "Europe/Moscow";

function stateOf(events: readonly MessageStreamEvent[]): ConversationState {
  return events.reduce<ConversationState>(
    (state, event) => conversationReducer.reduce(state, event),
    conversationReducer.initial(),
  );
}

function item(id: string, title: string | null, updatedAt: string): SessionListItem {
  return { id, title, createdAt: updatedAt, updatedAt };
}

const coffee = item(
  "00000000-0000-4000-8000-000000000001",
  "Промо для кофейни",
  "2026-11-01T11:05:00.000Z",
);
const yesterday = item(
  "00000000-0000-4000-8000-000000000002",
  null,
  "2026-10-31T06:30:00.000Z",
);
const thisYear = item(
  "00000000-0000-4000-8000-000000000003",
  "Ролик про пингвинов",
  "2026-10-12T12:00:00.000Z",
);
const otherYear = item(
  "00000000-0000-4000-8000-000000000004",
  "Отчёт за прошлый год",
  "2025-10-12T12:00:00.000Z",
);

const pageOf = (items: readonly SessionListItem[], nextCursor: string | null = null): SessionListPage => ({
  items,
  nextCursor,
});

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function list(props: {
  initialPage: SessionListPage;
  initialQuery?: string;
  initialError?: boolean;
  request: (input: SessionListQuery) => Promise<SessionListPage>;
}) {
  return (
    <div className="h-dvh">
      <SessionList
        initialError={props.initialError}
        initialPage={props.initialPage}
        initialQuery={props.initialQuery ?? ""}
        now={NOW}
        request={props.request}
        timeZone={ZONE}
      />
    </div>
  );
}

test("дата сессии: сегодня, вчера, этот год и другой год", () => {
  expect(formatSessionDate(new Date("2026-11-01T11:05:00Z"), NOW, ZONE)).toBe("сегодня, 14:05");
  expect(formatSessionDate(new Date("2026-10-31T06:30:00Z"), NOW, ZONE)).toBe("вчера, 09:30");
  expect(formatSessionDate(new Date("2026-10-12T12:00:00Z"), NOW, ZONE)).toBe("12 октября");
  expect(formatSessionDate(new Date("2025-10-12T12:00:00Z"), NOW, ZONE)).toBe("12 октября 2025 г.");
});

test("строка ведёт в сессию, обрезает длинное название и пишет дату", async () => {
  const longTitle = "я".repeat(300);
  const long = item("00000000-0000-4000-8000-000000000099", longTitle, "2026-09-03T12:00:00.000Z");
  const screen = await renderOnPhone(
    list({
      initialPage: pageOf([coffee, yesterday, thisYear, otherYear, long]),
      request: async () => pageOf([]),
    }),
  );

  await expect
    .element(page.getByRole("link", { name: /Промо для кофейни/ }))
    .toHaveAttribute("href", "/s/00000000-0000-4000-8000-000000000001");
  await expect.element(page.getByText("Без названия")).toBeVisible();
  await expect.element(page.getByText("сегодня, 14:05")).toBeVisible();
  await expect.element(page.getByText("вчера, 09:30")).toBeVisible();
  await expect.element(page.getByText("12 октября", { exact: true })).toBeVisible();
  await expect.element(page.getByText("12 октября 2025 г.")).toBeVisible();

  const title = document.querySelector("[data-slot=item-title]");
  const titles = [...document.querySelectorAll("[data-slot=item-title]")];
  const longNode = titles.find((node) => node.textContent === longTitle);
  expect(longNode).toBeDefined();
  expect(longNode?.textContent).toBe(longTitle);
  expect(longNode?.getClientRects().length).toBe(1);
  expect((longNode as HTMLElement).scrollWidth).toBeGreaterThan((longNode as HTMLElement).clientWidth);
  expect(title).not.toBeNull();
  expectNoHorizontalScroll();
  await screen.unmount();

  await renderOnDesktop(
    list({
      initialPage: pageOf([coffee, long]),
      request: async () => pageOf([]),
    }),
  );
  await expect.element(page.getByText("сегодня, 14:05")).toBeVisible();
  const desktopLong = [...document.querySelectorAll("[data-slot=item-title]")].find(
    (node) => node.textContent === longTitle,
  ) as HTMLElement;
  expect(desktopLong.getClientRects().length).toBe(1);
  expect(desktopLong.scrollWidth).toBeGreaterThan(desktopLong.clientWidth);
  expectNoHorizontalScroll();
});

test("поиск уходит один раз через 300 мс, очистка сбрасывает запрос", async () => {
  const calls: string[] = [];
  await renderOnDesktop(
    list({
      initialPage: pageOf([coffee]),
      request: async (input) => {
        calls.push(input.q);
        return input.q === "" ? pageOf([coffee]) : pageOf([]);
      },
    }),
  );

  const search = page.getByRole("textbox", { name: "Поиск по названиям" });
  await search.fill("  кофе ");
  expect(calls).toEqual([]);
  await wait(100);
  expect(calls).toEqual([]);
  await wait(250);
  expect(calls).toEqual(["кофе"]);

  await page.getByRole("button", { name: "Очистить поиск" }).click();
  await wait(400);
  expect(calls).toEqual(["кофе", ""]);
  expect((document.querySelector("input[aria-label='Поиск по названиям']") as HTMLInputElement).value).toBe(
    "",
  );
});

test("устаревший ответ поиска не затирает более новый", async () => {
  const pending: Array<(value: SessionListPage) => void> = [];
  await renderOnDesktop(
    list({
      initialPage: pageOf([coffee]),
      request: (input) =>
        new Promise((resolve) => {
          pending.push(resolve);
          void input;
        }),
    }),
  );

  await page.getByRole("textbox", { name: "Поиск по названиям" }).fill("первый");
  await wait(400);
  expect(pending).toHaveLength(1);
  await page.getByRole("textbox", { name: "Поиск по названиям" }).fill("второй");
  await wait(400);
  expect(pending).toHaveLength(2);

  pending[1]?.({
    items: [item("00000000-0000-4000-8000-000000000022", "Второй ролик", "2026-11-01T11:05:00.000Z")],
    nextCursor: null,
  });
  await expect.element(page.getByText("Второй ролик")).toBeVisible();
  pending[0]?.({
    items: [item("00000000-0000-4000-8000-000000000011", "Первый ролик", "2026-11-01T11:05:00.000Z")],
    nextCursor: null,
  });
  await wait(50);
  expect(document.body.textContent).toContain("Второй ролик");
  expect(document.body.textContent).not.toContain("Первый ролик");
});

test("«Показать ещё» есть только вместе с курсором и на время загрузки сменяется индикатором", async () => {
  let resolveMore: ((value: SessionListPage) => void) | undefined;
  const screen = await renderOnDesktop(
    list({
      initialPage: pageOf([coffee], "cursor-1"),
      request: () =>
        new Promise((resolve) => {
          resolveMore = resolve;
        }),
    }),
  );

  await expect.element(page.getByRole("button", { name: "Показать ещё" })).toBeVisible();
  await page.getByRole("button", { name: "Показать ещё" }).click();
  await expect.element(page.getByRole("status", { name: "Загрузка" })).toBeVisible();
  expect(document.body.textContent).not.toContain("Показать ещё");
  expect(document.body.textContent).toContain("Промо для кофейни");

  resolveMore?.({
    items: [item("00000000-0000-4000-8000-000000000055", "Вторая страница", "2026-10-12T12:00:00.000Z")],
    nextCursor: null,
  });
  await expect.element(page.getByText("Вторая страница")).toBeVisible();
  expect(document.body.textContent).not.toContain("Показать ещё");
  await screen.unmount();

  await renderOnDesktop(
    list({
      initialPage: pageOf([coffee], null),
      request: async () => pageOf([]),
    }),
  );
  expect(document.body.textContent).not.toContain("Показать ещё");
});

test("ошибка догрузки оставляет уже показанные сессии", async () => {
  await renderOnDesktop(
    list({
      initialPage: pageOf([coffee], "cursor-1"),
      request: async () => {
        throw new Error("сеть");
      },
    }),
  );
  await page.getByRole("button", { name: "Показать ещё" }).click();
  await expect.element(page.getByText("Не удалось загрузить сессии")).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Повторить" })).toBeVisible();
  await expect.element(page.getByText("Промо для кофейни")).toBeVisible();
});

test("состояния: скелеты, пустой список, пустой поиск и ошибка", async () => {
  let resolveSearch: ((value: SessionListPage) => void) | undefined;
  const searching = await renderOnDesktop(
    list({
      initialPage: pageOf([coffee]),
      request: () =>
        new Promise((resolve) => {
          resolveSearch = resolve;
        }),
    }),
  );
  await page.getByRole("textbox", { name: "Поиск по названиям" }).fill("кофе");
  await wait(400);
  expect(document.querySelectorAll("[data-slot=skeleton]").length).toBeGreaterThanOrEqual(3);
  resolveSearch?.(pageOf([]));
  await searching.unmount();

  const empty = await renderOnDesktop(
    list({
      initialPage: pageOf([]),
      request: async () => pageOf([]),
    }),
  );
  await expect.element(page.getByText("Сессий пока нет")).toBeVisible();
  await expect
    .element(page.getByText("Опишите ролик в поле выше, и сессия появится здесь"))
    .toBeVisible();
  expect(document.querySelector("input[aria-label='Поиск по названиям']")).toBeNull();
  await empty.unmount();

  const missed = await renderOnDesktop(
    list({
      initialPage: pageOf([]),
      initialQuery: "пингвин",
      request: async () => pageOf([]),
    }),
  );
  await expect.element(page.getByText("Ничего не найдено по запросу «пингвин»")).toBeVisible();
  await page.getByRole("button", { name: "Сбросить поиск" }).click();
  await expect.element(page.getByText("Сессий пока нет")).toBeVisible();
  await missed.unmount();

  let retried = 0;
  await renderOnDesktop(
    list({
      initialPage: pageOf([]),
      initialError: true,
      request: async () => {
        retried += 1;
        return pageOf([coffee]);
      },
    }),
  );
  await expect.element(page.getByText("Не удалось загрузить сессии")).toBeVisible();
  await page.getByRole("button", { name: "Повторить" }).click();
  await expect.element(page.getByText("Промо для кофейни")).toBeVisible();
  expect(retried).toBe(1);
});

function LayoutHarness() {
  const [events, setEvents] = useState<readonly MessageStreamEvent[]>([]);
  return (
    <div className="h-dvh">
      <ChatView
        agent={{ data: stateOf(events), events, status: "ready" }}
        onCancel={() => undefined}
        onRespond={() => undefined}
        onSend={() => {
          setEvents(simpleConversation);
        }}
        sessions={
          <SessionList
            initialPage={pageOf([coffee])}
            initialQuery=""
            now={NOW}
            request={async () => pageOf([coffee])}
            timeZone={ZONE}
          />
        }
      />
    </div>
  );
}

test("на /s поле ввода выше списка и остаётся тем же узлом после отправки", async () => {
  const phone = await renderOnPhone(<LayoutHarness />);
  const textarea = document.querySelector("textarea");
  const heading = document.querySelector("h2");
  expect(textarea).not.toBeNull();
  expect(heading?.textContent).toBe("Сессии");
  expect(textarea!.getBoundingClientRect().bottom).toBeLessThanOrEqual(
    heading!.getBoundingClientRect().top,
  );
  expect(document.body.textContent).not.toContain("Опишите, какой ролик нужно сделать");
  await page.getByRole("textbox", { name: "Поиск по названиям" }).fill("кофе");
  expect((textarea as HTMLTextAreaElement).value).toBe("");
  expect(document.querySelector("textarea")).toBe(textarea);
  expectNoHorizontalScroll();

  await page.getByRole("textbox", { name: "Сообщение агенту" }).fill("привет");
  await page.getByRole("button", { name: "Отправить" }).click();
  await expect.element(page.getByText("Эхо: привет")).toBeVisible();
  expect(document.querySelector("textarea")).toBe(textarea);
  expect(document.querySelector("h2")).toBeNull();
  await phone.unmount();

  await renderOnDesktop(<LayoutHarness />);
  const desktopInput = document.querySelector("textarea");
  const desktopHeading = document.querySelector("h2");
  expect(desktopInput!.getBoundingClientRect().bottom).toBeLessThanOrEqual(
    desktopHeading!.getBoundingClientRect().top,
  );
  expectNoHorizontalScroll();
});

function agentOf(events: readonly MessageStreamEvent[]): ChatAgent {
  return {
    cancel: async () => ({ status: "accepted" }),
    data: stateOf(events),
    error: undefined,
    events,
    respond: async () => undefined,
    send: async () => undefined,
    status: "ready",
  } as unknown as ChatAgent;
}

test("шапка берёт название после первого сообщения и не опрашивает его зря", async () => {
  const original = window.fetch;
  let calls = 0;
  window.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ title: "Сделай ролик про пингвинов" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const named = await renderOnDesktop(
      <div className="h-dvh">
        <ChatPanel
          agent={agentOf(simpleConversation)}
          appSessionId="00000000-0000-4000-8000-000000000010"
        />
      </div>,
    );
    await expect.element(page.getByRole("heading", { name: "Сделай ролик про пингвинов" })).toBeVisible();
    expect(calls).toBe(1);
    await named.unmount();

    calls = 0;
    const idle = await renderOnDesktop(
      <div className="h-dvh">
        <ChatPanel agent={agentOf([])} appSessionId="00000000-0000-4000-8000-000000000010" />
      </div>,
    );
    await wait(50);
    expect(calls).toBe(0);
    expect(document.querySelector("h1")?.textContent).toBe("Новая сессия");
    await idle.unmount();

    calls = 0;
    const preset = await renderOnDesktop(
      <div className="h-dvh">
        <ChatPanel
          agent={agentOf(simpleConversation)}
          appSessionId="00000000-0000-4000-8000-000000000010"
          initialTitle="Уже есть"
        />
      </div>,
    );
    await wait(50);
    expect(calls).toBe(0);
    expect(document.querySelector("h1")?.textContent).toBe("Уже есть");
    await preset.unmount();

    const preferred = await renderOnDesktop(
      <div className="h-dvh">
        <ChatPanel
          agent={agentOf(simpleConversation)}
          appSessionId="00000000-0000-4000-8000-000000000010"
          title="Своё название"
        />
      </div>,
    );
    expect(document.querySelector("h1")?.textContent).toBe("Своё название");
    await preferred.unmount();
  } finally {
    window.fetch = original;
  }
});
