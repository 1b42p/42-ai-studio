"use client";

import type { UserContent } from "ai";
import { useStudioAgent } from "./use-studio-agent";
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
  authorizationAllowHosts?: readonly string[];
}

/**
 * Новый чат `/s`: сессия приложения создаётся перед первой отправкой или
 * первой загрузкой файла. Идентификатор держится и в ref (заголовки хука
 * запоминают первую функцию), и в состоянии (опрос названия должен увидеть id
 * после создания).
 */
export function NewChat({ initialPage, initialQuery, initialError = false, authorizationAllowHosts }: NewChatProps) {
  const appSessionId = useRef<string | null>(null);
  const sessionCreation = useRef<Promise<string> | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [startError, setStartError] = useState<Error>();
  const messageGeneration = useRef(0);

  const agent = useStudioAgent({
    headers: (): Record<string, string> => {
      const id = appSessionId.current;
      return id === null ? {} : { "x-studio-session-id": id };
    },
    // Подробный ход копий приходит отдельными потоками (#12).
    followSubagents: true,
  });

  /**
   * Создаёт сессию приложения один раз; дальше отдаёт её же. Три параллельные
   * загрузки на `/s` приходят сюда одновременно — запрос один на всех.
   */
  const ensureSession = async (): Promise<string> => {
    if (appSessionId.current !== null) return appSessionId.current;
    if (sessionCreation.current !== null) return sessionCreation.current;

    setStartError(undefined);
    const creation = (async (): Promise<string> => {
      let response: Response;
      try {
        response = await fetch("/api/sessions", { method: "POST" });
        if (!response.ok) throw new Error("Session creation failed");
        const body = (await response.json()) as { id?: unknown };
        if (typeof body.id !== "string" || body.id.length === 0) throw new Error("Missing session id");
        appSessionId.current = body.id;
        setSessionId(body.id);
        replaceSessionUrl(body.id);
        return body.id;
      } catch {
        const error = new Error("Не удалось создать сессию. Попробуйте ещё раз.");
        setStartError(error);
        throw error;
      }
    })();

    sessionCreation.current = creation;
    try {
      return await creation;
    } finally {
      sessionCreation.current = null;
    }
  };

  const handleSend = async (content: string | UserContent) => {
    const generation = messageGeneration.current;
    await ensureSession();
    if (messageGeneration.current !== generation) throw new Error("Отправка остановлена.");
    const busy = isBusyStatus(agent.status);
    await agent.send(content, busy || Array.isArray(content) ? { turnPolicy: "steer" } : undefined);
  };

  return (
    <ChatPanel
      authorizationAllowHosts={authorizationAllowHosts}
      agent={agent}
      appSessionId={sessionId}
      ensureSession={ensureSession}
      errorOverride={startError}
      onSend={handleSend}
      onCancel={async () => {
        messageGeneration.current += 1;
        await agent.cancel();
      }}
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
