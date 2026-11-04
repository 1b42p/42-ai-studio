/**
 * Состояние беседы с копией агента (#12) для проверок отрисовки.
 *
 * Поток корня и вложенную беседу копии сворачивает штатный `conversationReducer`
 * из `eve/react`. Наблюдение за ходом копии (`data.agents[id].observation`)
 * приходит только клиентскими событиями `client.agent.*`, которых в публичном
 * API нет, поэтому его подставляет конструктор.
 */
import type { MessageStreamEvent } from "eve/client";
import { conversationReducer, type ConversationState } from "eve/react";

import { event } from "./events";

export const COPY_SESSION_ID = "wrun_copy_fixture";
export const COPY_TASK_ID = "task_copy_fixture";
export const COPY_CALL_ID = "call_copy_fixture";

export type CopyTaskStatus = "working" | "completed" | "failed" | "cancelled";
export type CopyObservation = "following" | "idle" | "unavailable" | "not-followed";

export interface CopyScenario {
  /** Статус задачи копии; `working` — она ещё работает. */
  readonly status?: CopyTaskStatus;
  /** Итог из `task.settled`. */
  readonly output?: string;
  /** Ошибка задачи. */
  readonly error?: string;
  /** Что известно о ходе копии. */
  readonly observation?: CopyObservation;
  /** События потока копии: из них собирается её беседа. */
  readonly copy?: readonly MessageStreamEvent[];
  /** Сообщение, которое родитель передал копии. */
  readonly message?: string;
  /** `false` — `agent.started` ещё не пришёл. */
  readonly started?: boolean;
  /** Копия задала вопрос и ждёт ответа. */
  readonly awaitingInput?: boolean;
}

export function reduceEvents(events: readonly MessageStreamEvent[]): ConversationState {
  return events.reduce<ConversationState>(
    (state, item) => conversationReducer.reduce(state, item),
    conversationReducer.initial(),
  );
}

/** Поток копии: последний блок её последнего сообщения виден в поле «Сейчас». */
export function copyStream(parts: {
  readonly tool?: { readonly name: string; readonly input?: unknown; readonly label?: string };
  /** Результат вызова: карточка показывает его вместо «выполняется». */
  readonly result?: unknown;
  readonly text?: string;
  /** Ход копии ещё идёт: незавершённый вызов остаётся в ленте. */
  readonly open?: boolean;
}): MessageStreamEvent[] {
  const events: MessageStreamEvent[] = [
    event("session.started", {}),
    event("turn.started", { turnId: "turn_0", sequence: 0 }),
    event("message.received", {
      message: "Собери черновик ролика",
      parts: [{ text: "Собери черновик ролика", type: "text" }],
      sequence: 0,
      turnId: "turn_0",
    }),
    event("step.started", { modelId: "eve-mock/model", sequence: 0, stepIndex: 0, turnId: "turn_0" }),
  ];

  if (parts.tool !== undefined) {
    events.push(
      event("actions.requested", {
        actions: [
          {
            callId: "call_copy_step",
            input: parts.tool.input ?? {},
            kind: "tool-call",
            toolName: parts.tool.name,
          },
        ],
        presentation:
          parts.tool.label === undefined ? {} : { call_copy_step: { label: parts.tool.label } },
        sequence: 0,
        stepIndex: 0,
        turnId: "turn_0",
      }),
    );
  }

  if (parts.tool !== undefined && parts.result !== undefined) {
    events.push(
      event("action.result", {
        result: {
          callId: "call_copy_step",
          kind: "tool-result",
          output: parts.result,
          toolName: parts.tool.name,
        },
        sequence: 0,
        status: "completed",
        stepIndex: 0,
        turnId: "turn_0",
      }),
    );
  }

  if (parts.text !== undefined) {
    events.push(
      event("message.appended", {
        messageDelta: parts.text,
        sequence: 0,
        stepIndex: 0,
        turnId: "turn_0",
      }),
      event("message.completed", {
        finishReason: "stop",
        message: parts.text,
        sequence: 0,
        stepIndex: 0,
        turnId: "turn_0",
      }),
    );
  }

  if (parts.open === true) return events;

  events.push(
    event("step.completed", {
      finishReason: "stop",
      sequence: 0,
      stepIndex: 0,
      turnId: "turn_0",
      usage: { cacheReadTokens: 0, cacheWriteTokens: 0, inputTokens: 10, outputTokens: 2 },
    }),
    event("turn.completed", { sequence: 0, turnId: "turn_0" }),
    event("session.waiting", {
      continuationToken: "wrun_fixture",
      usage: { cacheReadTokens: 0, cacheWriteTokens: 0, inputTokens: 10, outputTokens: 2 },
      wait: "next-user-message",
    }),
  );

  return events;
}

/** Поток корня с одним вызовом копии и состоянием её наблюдения. */
export function copyConversation(scenario: CopyScenario = {}): ConversationState {
  const {
    status = "working",
    output,
    error,
    observation = "following",
    copy = [],
    message = "Собери черновик ролика: раскадровка, кадры, музыка",
    started = true,
    awaitingInput = false,
  } = scenario;

  const events: MessageStreamEvent[] = [
    event("session.started", {}),
    event("turn.started", { turnId: "turn_0", sequence: 0 }),
    event("message.received", {
      message: "Запусти копию для черновика",
      parts: [{ text: "Запусти копию для черновика", type: "text" }],
      sequence: 0,
      turnId: "turn_0",
    }),
    event("step.started", { modelId: "eve-mock/model", sequence: 0, stepIndex: 0, turnId: "turn_0" }),
    event("actions.requested", {
      actions: [
        {
          callId: COPY_CALL_ID,
          description: "Копия корневого агента",
          input: { message },
          kind: "subagent-call",
          name: "agent",
          nodeId: "agent",
          subagentName: "agent",
        },
      ],
      presentation: { [COPY_CALL_ID]: { label: "Запускает копию агента" } },
      sequence: 0,
      stepIndex: 0,
      turnId: "turn_0",
    }),
    event("task.started", {
      callId: COPY_CALL_ID,
      kind: "agent",
      name: "agent",
      taskId: COPY_TASK_ID,
      turnId: "turn_0",
    }),
  ];

  if (started) {
    events.push(
      event("agent.started", {
        callId: COPY_CALL_ID,
        name: "agent",
        sessionId: COPY_SESSION_ID,
        streamPath: `/eve/v1/session/${COPY_SESSION_ID}/stream`,
        taskId: COPY_TASK_ID,
        turnId: "turn_0",
      }),
    );
  }

  if (awaitingInput) {
    events.push(
      event("input.requested", {
        callId: COPY_CALL_ID,
        requests: [
          {
            action: { callId: COPY_CALL_ID, input: {}, kind: "tool-call", toolName: "agent" },
            kind: "question",
            prompt: "Какой стиль выбрать?",
            requestId: "req_copy",
            options: [{ id: "retro", label: "Ретро" }],
          },
        ],
        sequence: 0,
        stepIndex: 0,
        taskId: COPY_TASK_ID,
        turnId: "turn_0",
      }),
    );
  }

  if (status !== "working") {
    events.push(
      event("task.settled", {
        callId: COPY_CALL_ID,
        kind: "agent",
        name: "agent",
        ...(output === undefined ? {} : { output }),
        ...(error === undefined ? {} : { error: { message: error } }),
        status,
        taskId: COPY_TASK_ID,
        turnId: "turn_0",
      }),
    );
  }

  events.push(
    event("step.completed", {
      finishReason: "stop",
      sequence: 0,
      stepIndex: 0,
      turnId: "turn_0",
      usage: { cacheReadTokens: 0, cacheWriteTokens: 0, inputTokens: 10, outputTokens: 2 },
    }),
    event("turn.completed", { sequence: 0, turnId: "turn_0" }),
    event("session.waiting", {
      continuationToken: "wrun_fixture",
      usage: { cacheReadTokens: 0, cacheWriteTokens: 0, inputTokens: 10, outputTokens: 2 },
      wait: "next-user-message",
    }),
  );

  const state = reduceEvents(events);
  const session = state.agents[COPY_SESSION_ID];
  if (session === undefined) return state;

  const conversation = reduceEvents(copy);
  const observed =
    observation === "following"
      ? { status: "following" as const, conversation }
      : observation === "idle"
        ? { status: "idle" as const, conversation }
        : observation === "unavailable"
          ? { status: "unavailable" as const }
          : { status: "not-followed" as const };

  return {
    ...state,
    agents: { ...state.agents, [COPY_SESSION_ID]: { ...session, observation: observed } },
  };
}
