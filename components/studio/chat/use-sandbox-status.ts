"use client";

import { useEffect, useRef, useState } from "react";

import type { SandboxStatus } from "@/lib/sandbox/status";

const POLL_INTERVAL_MS = 3_000;

/** Один начальный запрос восстанавливает баннер после возвращения в сессию. */
export function useSandboxStatus(appSessionId: string | null, busy: boolean): SandboxStatus | null {
  const [snapshot, setSnapshot] = useState<{
    appSessionId: string;
    status: SandboxStatus;
  } | null>(null);
  const lastWaiting = useRef<{ appSessionId: string; waiting: boolean } | null>(null);

  useEffect(() => {
    if (appSessionId === null) return;
    const sessionId = appSessionId;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let waiting = lastWaiting.current?.appSessionId === sessionId && lastWaiting.current.waiting;

    async function poll() {
      try {
        const response = await fetch(`/api/sessions/${sessionId}/sandbox`, {
          signal: controller.signal,
          cache: "no-store",
        });
        if (response.ok) {
          const status = await response.json() as SandboxStatus;
          if (controller.signal.aborted) return;
          waiting = status.state === "starting" || (status.state === "queued" && status.queue !== null);
          lastWaiting.current = { appSessionId: sessionId, waiting };
          setSnapshot({ appSessionId: sessionId, status });
        }
      } catch {
        // Краткий сбой сети не убирает очередь и не блокирует поле ввода.
      }
      if (!controller.signal.aborted && (busy || waiting)) {
        timer = setTimeout(() => void poll(), POLL_INTERVAL_MS);
      }
    }

    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [appSessionId, busy]);

  return snapshot?.appSessionId === appSessionId ? snapshot.status : null;
}
