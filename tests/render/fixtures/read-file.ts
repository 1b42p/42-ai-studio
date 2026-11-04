/** Чтение файла проходит через события и штатный reducer беседы eve. */
import type { MessageStreamEvent } from "eve/client";
import { conversationReducer, type ConversationState } from "eve/react";

import { event } from "./events";

export const frameImageId = "405856d4-5f49-4b57-bf4c-42bd224d1a0d";
export const frameName = `${"ДлинноеИмяКадра".repeat(24)}.jpeg`;
export const frameOutput = {
  path: `/workspace/coffee-promo/${"длинный-каталог/".repeat(30)}${frameName}`,
  content: "Скрытое содержимое файла",
  file: { mediaType: "image/jpeg", width: 1920, height: 1080, size: 98304 },
  media: { imageId: frameImageId },
};

export interface ReadFileScenario {
  label?: string;
  output?: unknown;
  error?: string;
  denied?: boolean;
}

export function readFileConversation(scenario: ReadFileScenario): {
  data: ConversationState;
  events: MessageStreamEvent[];
  status: "ready" | "streaming";
} {
  const { output, error, denied } = scenario;
  const events = [
    event("session.started", {}),
    event("turn.started", { turnId: "turn_0", sequence: 0 }),
    event("message.received", {
      message: "Проверь кадр ролика",
      parts: [{ text: "Проверь кадр ролика", type: "text" }],
      sequence: 0,
      turnId: "turn_0",
    }),
    event("step.started", { modelId: "eve-mock/model", sequence: 0, stepIndex: 0, turnId: "turn_0" }),
    event("actions.requested", {
      actions: [{ callId: "call_frame", input: { filePath: "/workspace/ВходнойПуть.jpeg" }, kind: "tool-call", toolName: "read_file" }],
      presentation: { call_frame: { label: scenario.label ?? "Читает опорный кадр" } },
      sequence: 0,
      stepIndex: 0,
      turnId: "turn_0",
    }),
  ];
  const finished = denied === true || error !== undefined || output !== undefined;
  if (finished) {
    events.push(
      event("action.result", {
        result: { callId: "call_frame", kind: "tool-result", output: error ?? output ?? "Внутренний отказ", isError: error !== undefined, toolName: "read_file" },
        sequence: 0,
        status: denied ? "rejected" : error === undefined ? "completed" : "failed",
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
    data: events.reduce<ConversationState>((state, item) => conversationReducer.reduce(state, item), conversationReducer.initial()),
    events,
    status: finished ? "ready" : "streaming",
  };
}
