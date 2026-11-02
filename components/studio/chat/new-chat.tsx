"use client";

import type { UserContent } from "ai";
import { useEveAgent } from "eve/react";
import { useRef, useState } from "react";

import { isBusyStatus } from "@/components/studio/chat/chat-status";
import { ChatPanel } from "@/components/studio/chat/chat-panel";
import {
  fetchSessionPage,
  SessionList,
  type SessionListPage,
} from "@/components/studio/sessions/session-list";

/**
 * Смена адреса без пересоздания чата: Next.js подменяет
 * `window.history.replaceState` и на каждый вызов восстанавливает маршрут,
 * отсоединяя идущий поток. Оригинальный метод меняет адрес молча.
 */
function replaceSessionUrl(id: string): void {
  History.prototype.replaceState.call(
    window.history,
    window.history.state,
    "",
    `/s/${encodeURIComponent(id)}`,
  );
}

export interface NewChatProps {
  initialPage: SessionListPage;
  /** Уже обрезанный запрос из адреса. Пустая строка — без фильтра. */
  initialQuery: string;
  /** Адрес с некорректным `q`: показать ошибку, а не пустой список. */
  initialError?: boolean;
}

/**
 * Новый чат `/s`: сессия приложения создаётся перед первой отправкой или
 * первой загрузкой файла. Идентификатор держится и в ref (заголовки хука
 * запоминают первую функцию), и в состоянии (опрос названия должен увидеть id
 * после создания).
 */
export function NewChat({ initialPage, initialQuery, initialError = false }: NewChatProps) {
  const appSessionId = useRef<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [startError, setStartError] = useState<Error>();

  const agent = useEveAgent({
    headers: (): Record<string, string> => {
      const id = appSessionId.current;
      return id === null ? {} : { "x-studio-session-id": id };
    },
  });

  /** Создаёт сессию приложения один раз; дальше отдаёт её же. */
  const ensureSession = async (): Promise<string> => {
    if (appSessionId.current !== null) return appSessionId.current;
    setStartError(undefined);

    const response = await fetch("/api/sessions", { method: "POST" });
    if (!response.ok) {
      const error = new Error("Не удалось создать сессию. Попробуйте ещё раз.");
      setStartError(error);
      throw error;
    }
    const body = (await response.json()) as { id: string };
    appSessionId.current = body.id;
    setSessionId(body.id);
    replaceSessionUrl(body.id);
    return body.id;
  };

  const handleSend = async (content: string | UserContent) => {
    await ensureSession();
    const busy = isBusyStatus(agent.status);
    await agent.send(content, busy ? { turnPolicy: "steer" } : undefined);
  };

  return (
    <ChatPanel
      agent={agent}
      appSessionId={sessionId}
      ensureSession={ensureSession}
      errorOverride={startError}
      onSend={handleSend}
      sessions={
        <SessionList
          initialError={initialError}
          initialPage={initialPage}
          initialQuery={initialQuery}
          request={fetchSessionPage}
        />
      }
    />
  );
}
