import type { ConversationState, EveDynamicToolPart } from "eve/react";

export function isQuestionCall(part: EveDynamicToolPart): boolean {
  return (part.toolMetadata?.eve?.name ?? part.toolName) === "ask_question";
}

export function questionsFor(data: ConversationState, callId: string) {
  return Object.values(data.inputs).filter((input) =>
    input.taskId === undefined && input.request.kind === "question" && input.request.action.callId === callId,
  );
}

/** Only root calls rendered in the transcript claim an inline prompt. */
export function inlineQuestionIds(data: ConversationState): ReadonlySet<string> {
  return new Set(data.messages.flatMap((message) => message.parts.flatMap((part) =>
    part.type === "dynamic-tool" && isQuestionCall(part)
      ? questionsFor(data, part.toolCallId).map((input) => input.request.requestId) : [],
  )));
}
