"use client";

import type {
  ConversationState,
  EveDynamicToolPart,
  EveMessage,
  EveMessagePart,
} from "eve/react";
import { BrainIcon } from "lucide-react";

import { ChatMarkdown } from "@/components/studio/chat/chat-markdown";
import { AuthorizationCard, type AuthorizationPart } from "./authorization-card";
import { InputPrompt, type RespondToInput } from "@/components/studio/chat/input-prompt";
import { isQuestionCall, questionsFor } from "@/components/studio/chat/input-routing";
import type { FileLookup } from "@/components/studio/chat/message-files";
import { MessageAttachments } from "@/components/studio/chat/message-attachments";
import { ToolCard } from "@/components/studio/chat/tool-card";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Message, MessageContent } from "@/components/ui/message";
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from "@/components/ui/trace";
import { messageIdOf } from "@/lib/media/message-id";

type AssistantGroup =
  | { readonly kind: "authorization"; readonly id: string; readonly part: AuthorizationPart }
  | { readonly kind: "question"; readonly id: string; readonly part: EveDynamicToolPart }
  | { readonly kind: "reasoning"; readonly id: string; readonly text: string; readonly running: boolean }
  | {
      readonly kind: "text";
      readonly id: string;
      readonly text: string;
      readonly streaming: boolean;
      readonly stepIndex?: number;
    }
  | { readonly kind: "tools"; readonly id: string; readonly parts: (EveDynamicToolPart | AuthorizationPart)[] };

function textOfUserMessage(message: EveMessage): string {
  return message.parts
    .filter((part): part is Extract<EveMessagePart, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function splitInlineReasoning(text: string): { reasoning?: string; answer: string } {
  const opening = /^\s*<thinking>/u.exec(text);
  if (!opening) return { answer: text };

  const content = text.slice(opening[0].length);
  // Some providers omit the final `>` and put the answer immediately after the tag.
  const closing = /<\/thinking>?/u.exec(content);
  if (!closing) return { reasoning: content, answer: "" };

  return {
    reasoning: content.slice(0, closing.index),
    answer: content.slice(closing.index + closing[0].length),
  };
}

/**
 * Подряд идущие размышления сливаются в одну строку, подряд идущие вызовы —
 * в один `Trace`. Пустые размышления не показываются.
 */
function groupAssistantParts(parts: readonly EveMessagePart[]): AssistantGroup[] {
  const groups: AssistantGroup[] = [];

  function addReasoning(id: string, text: string, running: boolean) {
    if (text.trim().length === 0) return;
    const last = groups.at(-1);
    if (last?.kind === "reasoning") {
      groups[groups.length - 1] = {
        ...last,
        text: last.text + text,
        running: last.running || running,
      };
    } else {
      groups.push({ kind: "reasoning", id, text, running });
    }
  }

  for (const part of parts) {
    if (part.type === "authorization") {
      const id = part.attemptId ?? `authorization-${groups.length}`;
      const last = groups.at(-1);
      if (part.state === "completed") {
        if (last?.kind === "tools") last.parts.push(part);
        else groups.push({ kind: "tools", id, parts: [part] });
      } else {
        groups.push({ kind: "authorization", id, part });
      }
      continue;
    }
    if (part.type === "text") {
      const { answer, reasoning } = splitInlineReasoning(part.text);
      const id = part.id ?? `text-${groups.length}`;
      const streaming = part.state === "streaming";
      if (reasoning !== undefined) {
        addReasoning(`${id}-inline-reasoning`, reasoning, streaming && answer.trim().length === 0);
      }
      if (answer.trim().length === 0) continue;
      groups.push({
        kind: "text",
        id,
        text: answer,
        streaming,
        stepIndex: part.stepIndex,
      });
      continue;
    }

    if (part.type === "reasoning") {
      addReasoning(part.id ?? `reasoning-${groups.length}`, part.text, part.state === "streaming");
      continue;
    }

    if (part.type === "dynamic-tool") {
      if (isQuestionCall(part)) {
        groups.push({ kind: "question", id: part.toolCallId, part });
        continue;
      }
      const last = groups.at(-1);
      if (last?.kind === "tools") {
        last.parts.push(part);
      } else {
        groups.push({ kind: "tools", id: part.toolCallId, parts: [part] });
      }
    }
  }

  return groups;
}

function ReasoningRow({ text, running }: { text: string; running: boolean }) {
  return (
    <TraceCollapsible defaultOpen={false}>
      <TraceCollapsibleTrigger>
        <TraceLine status={running ? "running" : undefined}>
          <TraceIcon>
            <BrainIcon />
          </TraceIcon>
          <TraceTitle>Размышление</TraceTitle>
        </TraceLine>
      </TraceCollapsibleTrigger>
      <TraceCollapsibleContent className="whitespace-pre-wrap">{text}</TraceCollapsibleContent>
    </TraceCollapsible>
  );
}

function AssistantContent({
  parts,
  turnId,
  files,
  data,
  appSessionId,
  onCopyPanelChange,
  onRespond,
  inputDisabled,
  authorizationAllowHosts,
}: {
  parts: readonly EveMessagePart[];
  turnId: string | undefined;
  files: FileLookup;
  data: ConversationState;
  appSessionId?: string | null;
  onCopyPanelChange?: (callId: string, open: boolean) => void;
  onRespond?: RespondToInput;
  inputDisabled?: boolean;
  authorizationAllowHosts?: readonly string[];
}) {
  const groups = groupAssistantParts(parts);

  return (
    <div className="flex w-full min-w-0 flex-col gap-3">
      {groups.map((group) => {
        if (group.kind === "authorization") {
          return <AuthorizationCard key={group.id} part={group.part} allowHosts={authorizationAllowHosts} />;
        }
        if (group.kind === "question") {
          // Copies are answered through the parent's pinned prompt.
          if (!onRespond) return null;
          return questionsFor(data, group.part.toolCallId).map((input) => (
            <InputPrompt key={input.request.requestId} input={input}
              disabled={inputDisabled} onRespond={onRespond} />
          ));
        }
        if (group.kind === "reasoning") {
          return (
            <Trace key={group.id}>
              <ReasoningRow running={group.running} text={group.text} />
            </Trace>
          );
        }

        if (group.kind === "tools") {
          return (
            <Trace key={group.id}>
              {group.parts.map((part, index) => part.type === "authorization" ? (
                <AuthorizationCard key={part.attemptId ?? `authorization-${index}`} part={part} allowHosts={authorizationAllowHosts} />
              ) : (
                <ToolCard
                  authorizationAllowHosts={authorizationAllowHosts}
                  appSessionId={appSessionId}
                  data={data}
                  key={part.toolCallId}
                  onCopyPanelChange={onCopyPanelChange}
                  part={part}
                />
              ))}
            </Trace>
          );
        }

        // Идентификатор сообщения тот же, что у сервера: `<turnId>:<stepIndex>`.
        const messageId = messageIdOf(turnId, group.stepIndex);

        return (
          <ChatMarkdown
            key={group.id}
            resolver={files.resolve(messageId)}
            streaming={group.streaming}
            text={group.text}
          />
        );
      })}
    </div>
  );
}

export interface MessageRowProps {
  readonly message: EveMessage;
  readonly data: ConversationState;
  readonly files: FileLookup;
  readonly appSessionId?: string | null;
  /** Панель копии открылась или закрылась. */
  readonly onCopyPanelChange?: (callId: string, open: boolean) => void;
  readonly onRespond?: RespondToInput;
  readonly inputDisabled?: boolean;
  readonly authorizationAllowHosts?: readonly string[];
}

/**
 * Одна реплика беседы. Одинаково рисуется в основном чате и в панели копии
 * агента: у копии те же карточки вызовов, только файлы песочницы выводятся
 * путём (`MessageFilesState.enabled: false`).
 */
export function MessageRow({ message, data, files, appSessionId, onCopyPanelChange, onRespond, inputDisabled, authorizationAllowHosts }: MessageRowProps) {
  const align = message.role === "user" ? "end" : "start";
  const text = textOfUserMessage(message);

  return (
    <Message align={align}>
      <MessageContent>
        {message.role === "user" ? (
          <>
            {text.trim().length === 0 ? null : (
              <Bubble align="end" variant="muted">
                <BubbleContent className="whitespace-pre-wrap">{text}</BubbleContent>
              </Bubble>
            )}
            <MessageAttachments parts={message.parts} />
          </>
        ) : (
          <AssistantContent
            authorizationAllowHosts={authorizationAllowHosts}
            appSessionId={appSessionId}
            data={data}
            files={files}
            onCopyPanelChange={onCopyPanelChange}
            onRespond={onRespond}
            inputDisabled={inputDisabled}
            parts={message.parts}
            turnId={message.metadata?.turnId}
          />
        )}
      </MessageContent>
    </Message>
  );
}
