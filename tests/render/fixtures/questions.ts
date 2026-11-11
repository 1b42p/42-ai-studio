import type { ConversationInput, ConversationState } from "eve/react";
import { conversationReducer } from "eve/react";

/** Ledger fixtures for root, relayed, and runtime prompts. */
export function question(overrides: Partial<ConversationInput> = {}): ConversationInput {
  return {
    request: {
      requestId: "req_question", kind: "question", prompt: "Какой формат кадра?", allowFreeform: true,
      action: { kind: "tool-call", toolName: "ask_question", callId: "call_question", input: { question: "Какой формат кадра?" } },
      options: [
        { id: "wide", label: "16:9", description: "Горизонтальный ролик" },
        { id: "vertical", label: "9:16", description: "Вертикальный ролик" },
        { id: "square", label: "1:1", description: "Квадратный ролик" },
      ],
    },
    turnId: "turn_old", stepIndex: 1, status: "open", ...overrides,
  };
}

export function questionsState(inputs: ConversationInput[], inline = true): ConversationState {
  return {
    ...conversationReducer.initial(),
    activeTurnId: "turn_new",
    inputs: Object.fromEntries(inputs.map((input) => [input.request.requestId, input])),
    messages: inline ? [{
      id: "old_message", role: "assistant", metadata: { turnId: "turn_old" },
      parts: [{ type: "text", text: "Перед вопросом", state: "done", stepIndex: 0 },
        { type: "dynamic-tool", toolCallId: "call_question", toolName: "ask_question", state: "input-available", input: {} },
        { type: "text", text: "После вопроса", state: "done", stepIndex: 2 }],
    }] : [],
  };
}

export function sessionLimit(): ConversationInput {
  return question({ request: {
    requestId: "req_limit", kind: "session-limit", prompt: "Continue?", allowFreeform: false,
    action: { kind: "tool-call", toolName: "runtime", callId: "limit_call", input: {} },
    options: [{ id: "continue", label: "Continue" }, { id: "cancel", label: "Stop", style: "danger" }],
  } });
}
