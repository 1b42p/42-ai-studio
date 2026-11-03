"use client";

import type {
  ConversationState,
  EveDynamicToolPart,
  EveMessage,
  EveMessagePart,
} from "eve/react";
import { BrainIcon } from "lucide-react";

import { ChatMarkdown } from "@/components/studio/chat/chat-markdown";
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
  | { readonly kind: "reasoning"; readonly id: string; readonly text: string; readonly running: boolean }
  | {
      readonly kind: "text";
      readonly id: string;
      readonly text: string;
      readonly streaming: boolean;
      readonly stepIndex?: number;
    }
  | { readonly kind: "tools"; readonly id: string; readonly parts: EveDynamicToolPart[] };

function textOfUserMessage(message: EveMessage): string {
  return message.parts
    .filter((part): part is Extract<EveMessagePart, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

/**
 * Подряд идущие размышления сливаются в одну строку, подряд идущие вызовы —
 * в один `Trace`. Пустые размышления не показываются.
 */
function groupAssistantParts(parts: readonly EveMessagePart[]): AssistantGroup[] {
  const groups: AssistantGroup[] = [];

  for (const part of parts) {
    if (part.type === "text") {
      if (part.text.trim().length === 0) continue;
      groups.push({
        kind: "text",
        id: part.id ?? `text-${groups.length}`,
        text: part.text,
        streaming: part.state === "streaming",
        stepIndex: part.stepIndex,
      });
      continue;
    }

    if (part.type === "reasoning") {
      if (part.text.trim().length === 0) continue;
      const last = groups.at(-1);
      if (last?.kind === "reasoning") {
        groups[groups.length - 1] = {
          ...last,
          text: last.text + part.text,
          running: last.running || part.state === "streaming",
        };
      } else {
        groups.push({
          kind: "reasoning",
          id: part.id ?? `reasoning-${groups.length}`,
          text: part.text,
          running: part.state === "streaming",
        });
      }
      continue;
    }

    if (part.type === "dynamic-tool") {
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
}: {
  parts: readonly EveMessagePart[];
  turnId: string | undefined;
  files: FileLookup;
  data: ConversationState;
  appSessionId?: string | null;
  onCopyPanelChange?: (callId: string, open: boolean) => void;
}) {
  const groups = groupAssistantParts(parts);

  return (
    <div className="flex w-full min-w-0 flex-col gap-3">
      {groups.map((group) => {
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
              {group.parts.map((part) => (
                <ToolCard
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
}

/**
 * Одна реплика беседы. Одинаково рисуется в основном чате и в панели копии
 * агента: у копии те же карточки вызовов, только файлы песочницы выводятся
 * путём (`MessageFilesState.enabled: false`).
 */
export function MessageRow({ message, data, files, appSessionId, onCopyPanelChange }: MessageRowProps) {
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
            appSessionId={appSessionId}
            data={data}
            files={files}
            onCopyPanelChange={onCopyPanelChange}
            parts={message.parts}
            turnId={message.metadata?.turnId}
          />
        )}
      </MessageContent>
    </Message>
  );
}
