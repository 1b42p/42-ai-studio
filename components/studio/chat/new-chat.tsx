"use client";

import { useEveAgent } from "eve/react";
import { useRef, useState } from "react";

import { isBusyStatus } from "@/components/studio/chat/chat-status";
import { ChatPanel } from "@/components/studio/chat/chat-panel";

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

/** Новый чат `/s`: сессия приложения создаётся перед первой отправкой. */
export function NewChat() {
  const appSessionId = useRef<string | null>(null);
  const [startError, setStartError] = useState<Error>();

  const agent = useEveAgent({
    headers: (): Record<string, string> => {
      const id = appSessionId.current;
      return id === null ? {} : { "x-studio-session-id": id };
    },
  });

  const handleSend = async (text: string) => {
    setStartError(undefined);

    if (appSessionId.current === null) {
      const response = await fetch("/api/sessions", { method: "POST" });
      if (!response.ok) {
        const error = new Error("Не удалось создать сессию. Попробуйте ещё раз.");
        setStartError(error);
        throw error;
      }
      const body = (await response.json()) as { id: string };
      appSessionId.current = body.id;
      replaceSessionUrl(body.id);
    }

    const busy = isBusyStatus(agent.status);
    await agent.send(text, busy ? { turnPolicy: "steer" } : undefined);
  };

  return <ChatPanel agent={agent} errorOverride={startError} onSend={handleSend} />;
}
