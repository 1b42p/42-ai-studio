"use client";

import { useEffect, useState } from "react";

import { sleep } from "@/lib/sleep";

const ATTEMPTS = 3;
const ATTEMPT_DELAY_MS = 1000;

/**
 * Название появляется без перезагрузки: после первого сообщения спрашиваем
 * сессию до трёх раз. Эффект зависит от факта сообщения, а не от массива
 * событий, иначе очистка отменяла бы уже начатый опрос.
 */
export function useSessionTitle(
  appSessionId: string | null,
  events: readonly { type: string }[],
  initialTitle: string | null,
): string | null {
  const [polled, setPolled] = useState<string | null>(null);
  const hasUserMessage = events.some((event) => event.type === "message.received");

  useEffect(() => {
    if (appSessionId === null || initialTitle || !hasUserMessage) return;
    let cancelled = false;

    const poll = async () => {
      for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
        if (cancelled) return;
        try {
          const response = await fetch(`/api/sessions/${appSessionId}`);
          if (response.ok) {
            const body = (await response.json()) as { title?: unknown };
            if (typeof body.title === "string" && body.title.length > 0) {
              if (!cancelled) setPolled(body.title);
              return;
            }
          }
        } catch {
          // Сеть могла моргнуть: следующая попытка через секунду.
        }
        if (attempt < ATTEMPTS - 1) await sleep(ATTEMPT_DELAY_MS);
      }
    };

    void poll();
    return () => {
      cancelled = true;
    };
  }, [appSessionId, hasUserMessage, initialTitle]);

  return initialTitle ?? polled;
}
