"use client";

import type { MessageStreamEvent } from "eve/client";
import { useEveAgent } from "eve/react";
import { useEffect, useState } from "react";

import { ChatFrame } from "@/components/studio/chat/chat-frame";
import { ChatPanel } from "@/components/studio/chat/chat-panel";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { sleep } from "@/lib/sleep";

const EVENTS_BATCH = 2000;
const START_POLL_MS = 1000;
const START_WAIT_MS = 15_000;

type Phase = "empty" | "error" | "loading" | "ready" | "starting";

/** Читает всю сохранённую историю пачками до курсора. */
async function loadAllEvents(appSessionId: string): Promise<MessageStreamEvent[]> {
  const events: MessageStreamEvent[] = [];
  let after = -1;

  for (;;) {
    const response = await fetch(
      `/api/sessions/${appSessionId}/events?after=${after}&limit=${EVENTS_BATCH}`,
    );
    if (!response.ok) throw new Error(`Не удалось загрузить события: ${response.status}`);

    const body = (await response.json()) as {
      events: Array<{ seq: number; payload: MessageStreamEvent }>;
      cursor: number;
    };
    events.push(...body.events.map((item) => item.payload));

    const last = body.events.at(-1);
    if (last === undefined || events.length >= body.cursor) return events;
    after = last.seq;
  }
}

function ChatWithSession({
  appSessionId,
  initialTitle,
}: {
  appSessionId: string;
  initialTitle: string | null;
}) {
  const agent = useEveAgent({
    headers: () => ({ "x-studio-session-id": appSessionId }),
    followSubagents: true,
  });

  return (
    <ChatPanel
      agent={agent}
      appSessionId={appSessionId}
      ensureSession={async () => appSessionId}
      initialTitle={initialTitle}
    />
  );
}

function ResumedChatSession({
  appSessionId,
  eveSessionId,
  initialEvents,
  initialTitle,
}: {
  appSessionId: string;
  eveSessionId: string;
  initialEvents: readonly MessageStreamEvent[];
  initialTitle: string | null;
}) {
  const agent = useEveAgent({
    headers: () => ({ "x-studio-session-id": appSessionId }),
    initialEvents,
    initialSession: { sessionId: eveSessionId, streamIndex: initialEvents.length },
    resume: true,
    followSubagents: true,
  });

  return (
    <ChatPanel
      agent={agent}
      appSessionId={appSessionId}
      ensureSession={async () => appSessionId}
      initialTitle={initialTitle}
    />
  );
}

function StatusScreen({ text }: { text: string }) {
  return (
    <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
      <Spinner />
      <span role="status">{text}</span>
    </div>
  );
}

function LoadError({ text }: { text: string }) {
  return (
    <div className="mx-auto flex w-full max-w-3xl items-start p-6">
      <Alert variant="destructive">
        <AlertTitle>Не удалось открыть беседу</AlertTitle>
        <AlertDescription>
          {text}{" "}
          <Button
            className="h-auto p-0 align-baseline"
            nativeButton={false}
            render={<a href="/s" />}
            size="sm"
            variant="link"
          >
            Начать новую сессию
          </Button>
        </AlertDescription>
      </Alert>
    </div>
  );
}

export interface ResumedChatProps {
  appSessionId: string;
  initialEveSessionId: string | null;
  /** Название с сервера. Пока пустое, шапка спросит его после первого сообщения. */
  initialTitle: string | null;
  /** Создание сессии eve начато не дольше 60 секунд назад. */
  starting: boolean;
}

/**
 * Страница беседы: пока история не загружена, чат не монтируется — хук
 * `useEveAgent` читает `initialEvents` и `initialSession` при создании
 * хранилища, то есть на первом рендере.
 */
export function ResumedChat({
  appSessionId,
  initialEveSessionId,
  initialTitle,
  starting,
}: ResumedChatProps) {
  const [eveSessionId, setEveSessionId] = useState<string | null>(initialEveSessionId);
  const [phase, setPhase] = useState<Phase>(
    initialEveSessionId !== null ? "loading" : starting ? "starting" : "empty",
  );
  const [events, setEvents] = useState<readonly MessageStreamEvent[]>([]);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (phase !== "starting") return;
    let cancelled = false;

    const poll = async () => {
      const deadline = Date.now() + START_WAIT_MS;
      while (!cancelled && Date.now() < deadline) {
        await sleep(START_POLL_MS);
        if (cancelled) return;

        const response = await fetch(`/api/sessions/${appSessionId}`);
        if (!response.ok) continue;
        const body = (await response.json()) as { eveSessionId: string | null };
        if (body.eveSessionId !== null) {
          if (cancelled) return;
          setEveSessionId(body.eveSessionId);
          setPhase("loading");
          return;
        }
      }

      if (!cancelled) {
        setError("Сообщение не отправилось: сессия eve не создалась.");
        setPhase("error");
      }
    };

    void poll();
    return () => {
      cancelled = true;
    };
  }, [appSessionId, phase]);

  useEffect(() => {
    if (eveSessionId === null) return;
    let cancelled = false;

    const load = async () => {
      try {
        const loaded = await loadAllEvents(appSessionId);
        if (cancelled) return;
        setEvents(loaded);
        setPhase("ready");
      } catch (cause) {
        if (cancelled) return;
        setError(cause instanceof Error ? cause.message : "Не удалось загрузить беседу.");
        setPhase("error");
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [appSessionId, eveSessionId]);

  return (
    <ChatFrame>
      {phase === "starting" ? <StatusScreen text="Сообщение отправляется…" /> : null}
      {phase === "loading" ? <StatusScreen text="Загружаем беседу…" /> : null}
      {phase === "error" ? <LoadError text={error ?? "Неизвестная ошибка."} /> : null}
      {phase === "empty" ? (
        <ChatWithSession appSessionId={appSessionId} initialTitle={initialTitle} />
      ) : null}
      {phase === "ready" && eveSessionId !== null ? (
        <ResumedChatSession
          appSessionId={appSessionId}
          eveSessionId={eveSessionId}
          initialEvents={events}
          initialTitle={initialTitle}
        />
      ) : null}
    </ChatFrame>
  );
}
