/** События веб-инструментов: состояние чата строит штатный reducer eve. */
import type { MessageStreamEvent } from "eve/client";
import { conversationReducer, type ConversationState } from "eve/react";

import { event } from "./events";

export const searchQuery = "МонтажРусскоязычногоРолика".repeat(15);
export const searchResults = Array.from({ length: 10 }, (_, index) => ({
  title: `${index + 1}. ${"ДлинныйЗаголовокБезПробелов".repeat(15)}`.slice(0, 300),
  url: `https://example.com/${index}/${"a".repeat(500)}`.slice(0, 500),
  host: `${"длинный-хост.".repeat(12)}example.com`,
  snippet: "Фрагмент для модели, не для карточки",
  publishedDate: null,
  score: 0.81,
}));

export const pageResult = {
  url: "https://example.com/original",
  finalUrl: `https://${"long-host.".repeat(18)}example.com/article`,
  title: "ЗаголовокПрочитаннойСтраницы".repeat(15),
  byline: "Автор статьи",
  siteName: "Издание",
  publishedTime: "2026-11-01T12:00:00Z",
  lang: "ru",
  contentType: "text/html",
  extraction: "article",
  content: "Текст".repeat(5000),
  offset: 0,
  nextOffset: null,
  totalChars: 25000,
} as const;

export interface WebToolScenario {
  tool: "web_search" | "read_page";
  label?: string;
  output?: unknown;
  error?: string;
}

export function webToolConversation(scenario: WebToolScenario): {
  data: ConversationState;
  events: MessageStreamEvent[];
  status: "ready" | "streaming";
} {
  const { tool, output, error } = scenario;
  const events = [
    event("session.started", {}),
    event("turn.started", { turnId: "turn_0", sequence: 0 }),
    event("message.received", {
      message: "Найди и прочитай источники для ролика",
      parts: [{ text: "Найди и прочитай источники для ролика", type: "text" }],
      sequence: 0,
      turnId: "turn_0",
    }),
    event("step.started", { modelId: "eve-mock/model", sequence: 0, stepIndex: 0, turnId: "turn_0" }),
    event("actions.requested", {
      actions: [{
        callId: "call_web",
        input: tool === "web_search" ? { query: "Входной запрос не показывается" } : { url: "https://input.example.com/" },
        kind: "tool-call",
        toolName: tool,
      }],
      presentation: { call_web: { label: scenario.label ?? (tool === "web_search" ? "Поиск: факты для ролика" : "Чтение страницы: example.com") } },
      sequence: 0,
      stepIndex: 0,
      turnId: "turn_0",
    }),
  ];

  const finished = error !== undefined || output !== undefined;
  if (finished) {
    events.push(
      event("action.result", {
        result: { callId: "call_web", kind: "tool-result", output: error ?? output, isError: error !== undefined, toolName: tool },
        sequence: 0,
        status: error === undefined ? "completed" : "failed",
        stepIndex: 0,
        turnId: "turn_0",
      }),
      event("step.completed", {
        finishReason: "stop", sequence: 0, stepIndex: 0, turnId: "turn_0",
        usage: { cacheReadTokens: 0, cacheWriteTokens: 0, inputTokens: 10, outputTokens: 2 },
      }),
      event("turn.completed", { sequence: 0, turnId: "turn_0" }),
      event("session.waiting", {
        continuationToken: "wrun_fixture", wait: "next-user-message",
        usage: { cacheReadTokens: 0, cacheWriteTokens: 0, inputTokens: 10, outputTokens: 2 },
      }),
    );
  }

  return {
    data: events.reduce<ConversationState>(
      (state, item) => conversationReducer.reduce(state, item),
      conversationReducer.initial(),
    ),
    events,
    status: finished ? "ready" : "streaming",
  };
}
