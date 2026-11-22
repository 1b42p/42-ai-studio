import type { MessageStreamEvent } from "eve/client";
import type { EveMessage, EveMessagePart } from "eve/react";

import { messageIdOf } from "@/lib/media/message-id";

type Completion = Extract<MessageStreamEvent, { type: "message.completed" }>["data"];
type TextPart = Extract<EveMessagePart, { type: "text" }>;

interface StepTranscript {
  readonly attempts: Completion[][];
  readonly starts: Set<string>;
  closed: boolean;
}

function stepTranscripts(events: readonly MessageStreamEvent[]): Map<string, StepTranscript> {
  const steps = new Map<string, StepTranscript>();
  for (const event of events) {
    if (event.type !== "step.started" && event.type !== "step.completed" &&
        event.type !== "step.failed" && event.type !== "message.completed") continue;
    const stepId = messageIdOf(event.data.turnId, event.data.stepIndex);
    if (stepId === undefined) continue;
    const step = steps.get(stepId);
    if (event.type === "step.started") {
      // A durable retry emits a new start for this step, with a new event ID.
      if (!event.meta.id || step?.closed || step?.starts.has(event.meta.id)) continue;
      if (step === undefined) {
        steps.set(stepId, { attempts: [[]], starts: new Set([event.meta.id]), closed: false });
      } else {
        step.starts.add(event.meta.id);
        step.attempts.push([]);
      }
    } else if (event.type === "message.completed") {
      step?.attempts.at(-1)?.push(event.data);
    } else if (step !== undefined) {
      step.closed = true;
    }
  }
  return steps;
}

function sameCompletion(a: Completion, b: Completion): boolean {
  return a.sequence === b.sequence && a.finishReason === b.finishReason && a.message === b.message;
}

/**
 * Do not change the Eve store or stream. Hide only an identical completed
 * prefix across separate starts of an unfinished step. Repeated blocks within
 * one start, different outputs, and repeats on other steps/turns stay visible.
 */
export function displayMessages(
  messages: readonly EveMessage[],
  events: readonly MessageStreamEvent[],
): readonly EveMessage[] {
  const transcripts = stepTranscripts(events);
  if (![...transcripts.values()].some((step) => step.attempts.length > 1)) return messages;

  return messages.map((message) => {
    const turnId = message.metadata?.turnId;
    if (message.role !== "assistant" || turnId === undefined) return message;
    const partsByStep = new Map<string, TextPart[]>();
    for (const part of message.parts) {
      if (part.type !== "text" || part.state !== "done") continue;
      const stepId = messageIdOf(turnId, part.stepIndex);
      if (stepId === undefined || (transcripts.get(stepId)?.attempts.length ?? 0) < 2) continue;
      const parts = partsByStep.get(stepId);
      if (parts === undefined) partsByStep.set(stepId, [part]);
      else parts.push(part);
    }

    const hidden = new Set<TextPart>();
    for (const [stepId, parts] of partsByStep) {
      const { attempts } = transcripts.get(stepId)!;
      const completed = attempts.flat();
      // The SDK keys parts by their first append (or the completion if no
      // append was streamed). Require the finalized projection to agree with
      // the event transcript before matching by position.
      if (parts.length !== completed.length || !parts.every((part, i) => part.text === completed[i]?.message)) {
        continue;
      }
      let offset = 0;
      for (const [index, attempt] of attempts.entries()) {
        let previous = attempts.slice(0, index);
        for (const [position, block] of attempt.entries()) {
          previous = previous.filter((other) => other[position] !== undefined && sameCompletion(block, other[position]));
          if (previous.length === 0) break;
          hidden.add(parts[offset + position]!);
        }
        offset += attempt.length;
      }
    }

    return hidden.size === 0 ? message : {
      ...message,
      parts: message.parts.filter((part) => part.type !== "text" || !hidden.has(part)),
    };
  });
}
