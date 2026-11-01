"use client";

import type { ConversationState, UseEveAgentHelpers } from "eve/react";

import { isBusyStatus } from "@/components/studio/chat/chat-status";
import { ChatView, type ChatViewProps } from "@/components/studio/chat/chat-view";
import { useSessionTitle } from "@/components/studio/chat/use-session-title";

export type ChatAgent = UseEveAgentHelpers<ConversationState>;

export interface ChatPanelProps
  extends Omit<ChatViewProps, "agent" | "onCancel" | "onRespond" | "onSend"> {
  agent: ChatAgent;
  /** Ошибка подготовки сессии, показывается вместо ошибки хука. */
  errorOverride?: Error;
  /** Перекрывает отправку: например, перед первым сообщением создать сессию. */
  onSend?: (text: string) => void | Promise<void>;
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
  appSessionId = null,
  initialTitle = null,
  title: titleProp,
  ...props
}: ChatPanelProps) {
  const busy = isBusyStatus(agent.status);
  const polled = useSessionTitle(appSessionId, agent.events, initialTitle);
  // `null` оставил бы пустую шапку: у ChatView значение по умолчанию только для `undefined`.
  const title = titleProp ?? (polled === null ? undefined : polled);

  return (
    <ChatView
      {...props}
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
        (async (text) => {
          await agent.send(text, busy ? { turnPolicy: "steer" } : undefined);
        })
      }
      title={title}
    />
  );
}
