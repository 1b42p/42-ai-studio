/**
 * Фикстуры бесед для проверок отрисовки. Списки событий — в том виде, в каком
 * они лежат в `session_events.payload`; состояние строит штатный
 * `conversationReducer` из `eve/react`.
 *
 * Простая беседа снята из настоящего потока фикстурной модели
 * (`tests/render/fixtures/simple-conversation.json`, HTTP-тест с `APP_TEST_MODE=1`).
 * Остальные собраны конструктором `events.ts`.
 */
import type { MessageStreamEvent } from "eve/client";

import { event } from "./events";
import simpleConversationJson from "./simple-conversation.json";

export const simpleConversation = simpleConversationJson as unknown as MessageStreamEvent[];

function turnStarted(turnId = "turn_0"): MessageStreamEvent {
  return event("turn.started", { turnId, sequence: 0 });
}

function userMessage(turnId: string, text: string): MessageStreamEvent {
  return event("message.received", {
    message: text,
    parts: [{ text, type: "text" }],
    sequence: 0,
    turnId,
  });
}

function stepStarted(turnId: string, stepIndex = 0): MessageStreamEvent {
  return event("step.started", { modelId: "eve-mock/model", sequence: 0, stepIndex, turnId });
}

function stepCompleted(turnId: string, stepIndex = 0): MessageStreamEvent {
  return event("step.completed", {
    finishReason: "stop",
    sequence: 0,
    stepIndex,
    turnId,
    usage: { cacheReadTokens: 0, cacheWriteTokens: 0, inputTokens: 10, outputTokens: 2 },
  });
}

export function assistantText(turnId: string, text: string, stepIndex = 0): MessageStreamEvent[] {
  return [
    stepStarted(turnId, stepIndex),
    event("message.appended", {
      messageDelta: text,
      sequence: 0,
      stepIndex,
      turnId,
    }),
    event("message.completed", {
      finishReason: "stop",
      message: text,
      sequence: 0,
      stepIndex,
      turnId,
    }),
    stepCompleted(turnId, stepIndex),
  ];
}

function turnCompleted(turnId = "turn_0"): MessageStreamEvent {
  return event("turn.completed", { sequence: 0, turnId });
}

function sessionWaiting(): MessageStreamEvent {
  return event("session.waiting", {
    continuationToken: "wrun_fixture",
    usage: { cacheReadTokens: 0, cacheWriteTokens: 0, inputTokens: 10, outputTokens: 2 },
    wait: "next-user-message",
  });
}

/** Размышление, свёрнутое в строку «Размышление». */
export function reasoningConversation(): MessageStreamEvent[] {
  return [
    event("session.started", {}),
    turnStarted(),
    userMessage("turn_0", "Как сделать ролик?"),
    stepStarted("turn_0"),
    event("reasoning.appended", { reasoningDelta: "Сначала выясню ", sequence: 0, stepIndex: 0, turnId: "turn_0" }),
    event("reasoning.appended", { reasoningDelta: "тему и длительность.", sequence: 0, stepIndex: 0, turnId: "turn_0" }),
    event("reasoning.completed", {
      reasoning: "Сначала выясню тему и длительность.",
      sequence: 0,
      stepIndex: 0,
      turnId: "turn_0",
    }),
    event("message.completed", {
      finishReason: "stop",
      message: "Расскажите, о чём ролик.",
      sequence: 0,
      stepIndex: 0,
      turnId: "turn_0",
    }),
    stepCompleted("turn_0"),
    turnCompleted(),
    sessionWaiting(),
  ];
}

/** Вызов инструмента: в ленте только подпись, без имени, входа и результата. */
export function toolConversation(): MessageStreamEvent[] {
  return [
    event("session.started", {}),
    turnStarted(),
    userMessage("turn_0", "Проверь папку"),
    stepStarted("turn_0"),
    event("actions.requested", {
      actions: [{ callId: "call_1", input: { command: "ls" }, kind: "tool-call", toolName: "inspect_directory" }],
      presentation: { call_1: { label: "Проверяет папку" } },
      sequence: 0,
      stepIndex: 0,
      turnId: "turn_0",
    }),
    event("action.result", {
      result: { callId: "call_1", kind: "tool-result", output: "секретный-вывод", toolName: "inspect_directory" },
      sequence: 0,
      status: "completed",
      stepIndex: 0,
      turnId: "turn_0",
    }),
    event("message.completed", {
      finishReason: "stop",
      message: "Готово.",
      sequence: 0,
      stepIndex: 0,
      turnId: "turn_0",
    }),
    stepCompleted("turn_0"),
    turnCompleted(),
    sessionWaiting(),
  ];
}

/** Открытый вопрос с вариантами и своим ответом. */
export function questionConversation(): MessageStreamEvent[] {
  return [
    event("session.started", {}),
    turnStarted(),
    userMessage("turn_0", "Сделай ролик"),
    stepStarted("turn_0"),
    event("input.requested", {
      requests: [
        {
          action: { callId: "call_q", input: {}, kind: "tool-call", toolName: "ask_question" },
          allowFreeform: true,
          kind: "question",
          options: [
            { id: "retro", label: "Ретро" },
            { id: "minimal", label: "Минимализм" },
          ],
          prompt: "Какой стиль выбрать?",
          requestId: "req_1",
        },
      ],
      sequence: 0,
      stepIndex: 0,
      turnId: "turn_0",
    }),
    event("turn.waiting", { on: "input", sequence: 0, turnId: "turn_0" }),
  ];
}

/** Ошибка модели: код `MODEL_CALL_FAILED`. */
export function failedConversation(): MessageStreamEvent[] {
  return [
    event("session.started", {}),
    turnStarted(),
    userMessage("turn_0", "Ответь"),
    stepStarted("turn_0"),
    event("step.failed", { code: "MODEL_CALL_FAILED", message: "Провайдер вернул 503", sequence: 0, stepIndex: 0, turnId: "turn_0" }),
    event("turn.failed", {
      code: "MODEL_CALL_FAILED",
      message: "Провайдер вернул 503",
      sequence: 0,
      terminal: false,
      turnId: "turn_0",
    }),
    sessionWaiting(),
  ];
}

/** Отменённый ход. */
export function cancelledConversation(): MessageStreamEvent[] {
  return [
    event("session.started", {}),
    turnStarted(),
    userMessage("turn_0", "/slow 15 долго"),
    stepStarted("turn_0"),
    event("turn.cancelled", { sequence: 0, turnId: "turn_0" }),
    sessionWaiting(),
  ];
}

/** Завершённая сессия: поля ввода нет. */
export function completedConversation(): MessageStreamEvent[] {
  return [
    event("session.started", {}),
    turnStarted(),
    userMessage("turn_0", "привет"),
    ...assistantText("turn_0", "Эхо: привет"),
    turnCompleted(),
    event("session.completed", {
      usage: { cacheReadTokens: 0, cacheWriteTokens: 0, inputTokens: 10, outputTokens: 2 },
    }),
  ];
}

/** Ответ с файлами песочницы: пути разрешаются через `messageFiles`. */
export function fileConversation(text: string): MessageStreamEvent[] {
  return [
    event("session.started", {}),
    turnStarted("turn_0"),
    userMessage("turn_0", "Покажи файлы"),
    ...assistantText("turn_0", text),
    turnCompleted("turn_0"),
    sessionWaiting(),
  ];
}

/** Сообщение пользователя с файловыми частями (#9). */
export function userFilesConversation(
  parts: ReadonlyArray<{ filename?: string; mediaType: string; url?: string }>,
): MessageStreamEvent[] {
  return [
    event("session.started", {}),
    turnStarted("turn_0"),
    event("message.received", {
      message: "",
      parts,
      sequence: 0,
      turnId: "turn_0",
    }),
    ...assistantText("turn_0", "Файлы получены."),
    turnCompleted("turn_0"),
    sessionWaiting(),
  ];
}

/** Длинное слово, широкая таблица и длинный блок кода. */
export function wideContentConversation(): MessageStreamEvent[] {
  const word = "оченьдлинноесловобезпробелов".repeat(12);
  const table = [
    "| Параметр | Значение | Комментарий | Ещё | И ещё |",
    "| --- | --- | --- | --- | --- |",
    "| очень длинное значение | очень длинное значение | очень длинное значение | очень длинное значение | очень длинное значение |",
  ].join("\n");
  const code = ["```ts", ...Array.from({ length: 12 }, (_, index) => `const value${index} = "строка без переносов".repeat(8);`), "```"].join("\n");
  const text = `${word}\n\n${table}\n\n${code}`;

  return [
    event("session.started", {}),
    turnStarted(),
    userMessage("turn_0", "Покажи широкий ответ"),
    ...assistantText("turn_0", text),
    turnCompleted(),
    sessionWaiting(),
  ];
}
