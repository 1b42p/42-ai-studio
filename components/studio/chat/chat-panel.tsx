"use client";

import type { UserContent } from "ai";
import type { ConversationState, UseEveAgentHelpers } from "eve/react";

import { isBusyStatus } from "@/components/studio/chat/chat-status";
import { ChatView, type ChatViewProps } from "@/components/studio/chat/chat-view";
import { useAttachments } from "@/components/studio/chat/use-attachments";
import { useMessageFiles } from "@/components/studio/chat/use-message-files";
import { useSessionTitle } from "@/components/studio/chat/use-session-title";
import { useSandboxStatus } from "@/components/studio/chat/use-sandbox-status";

export type ChatAgent = UseEveAgentHelpers<ConversationState>;

export interface ChatPanelProps
  extends Omit<ChatViewProps, "agent" | "attachments" | "sandboxStatus" | "onCancel" | "onRespond" | "onSend"> {
  agent: ChatAgent;
  /** Ошибка подготовки сессии, показывается вместо ошибки хука. */
  errorOverride?: Error;
  /** Перекрывает отправку: например, перед первым сообщением создать сессию. */
  onSend?: (content: string | UserContent) => void | Promise<void>;
  /** Создаёт сессию приложения перед первой загрузкой на странице `/s`. */
  ensureSession?: () => Promise<string>;
  /** Сессия приложения. Без неё название в шапке не опрашивается. */
  appSessionId?: string | null;
  /** Название с сервера. Пока его нет — опрос после первого сообщения. */
  initialTitle?: string | null;
}

/**
 * Тонкая обёртка над `useEveAgent`: хук живёт здесь, а беседа получает
 * готовое состояние свойствами и отрисовывается в тестах без сети.
 */
export function ChatPanel({
  agent,
  errorOverride,
  onSend,
  ensureSession,
  appSessionId = null,
  initialTitle = null,
  title: titleProp,
  ...props
}: ChatPanelProps) {
  const busy = isBusyStatus(agent.status);
  const sandboxStatus = useSandboxStatus(appSessionId, busy);
  const polled = useSessionTitle(appSessionId, agent.events, initialTitle);
  const attachments = useAttachments({ appSessionId, ensureSession });
  const messageFiles = useMessageFiles({
    appSessionId,
    events: agent.events,
    messages: agent.data.messages,
    status: agent.status,
    enabled: props.messageFiles === undefined,
  });
  // `null` оставил бы пустую шапку: у ChatView значение по умолчанию только для `undefined`.
  const title = titleProp ?? (polled === null ? undefined : polled);

  return (
    <ChatView
      {...props}
      appSessionId={appSessionId}
      attachments={attachments}
      sandboxStatus={sandboxStatus}
      messageFiles={props.messageFiles ?? messageFiles}
      agent={{
        data: agent.data,
        events: agent.events,
        status: agent.status,
        error: errorOverride ?? agent.error,
      }}
      onCancel={async () => {
        await agent.cancel();
      }}
      onRespond={async (responses) => {
        await agent.respond(responses);
      }}
      onSend={
        onSend ??
        (async (content) => {
          await agent.send(content, busy || Array.isArray(content) ? { turnPolicy: "steer" } : undefined);
        })
      }
      title={title}
    />
  );
}
