"use client";

import type { MessageStreamEvent } from "eve/client";
import { useStudioAgent } from "./use-studio-agent";
import { useEffect, useState } from "react";

import { ChatFrame } from "@/components/studio/chat/chat-frame";
import { ChatPanel } from "@/components/studio/chat/chat-panel";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { ButtonLink } from "@/components/studio/button-link";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";

const EVENTS_BATCH = 2000;
const START_POLL_MS = 1000;
const REQUEST_TIMEOUT_MS = 10_000;

type Phase = "empty" | "error" | "loading" | "ready" | "starting";

function fetchForResume(url: string, signal: AbortSignal): Promise<Response> {
  return fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]) });
}

/** Читает всю сохранённую историю пачками до курсора. */
async function loadAllEvents(appSessionId: string, signal: AbortSignal): Promise<MessageStreamEvent[]> {
  const events: MessageStreamEvent[] = [];
  let after = -1;

  for (;;) {
    const response = await fetchForResume(
      `/api/sessions/${appSessionId}/events?after=${after}&limit=${EVENTS_BATCH}`,
      signal,
    );
    if (!response.ok) throw new Error("Не удалось загрузить события.");

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
  authorizationAllowHosts,
}: {
  appSessionId: string;
  initialTitle: string | null;
  authorizationAllowHosts?: readonly string[];
}) {
  const agent = useStudioAgent({
    headers: () => ({ "x-studio-session-id": appSessionId }),
    followSubagents: true,
  });

  return (
    <ChatPanel
      authorizationAllowHosts={authorizationAllowHosts}
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
  authorizationAllowHosts,
}: {
  appSessionId: string;
  eveSessionId: string;
  initialEvents: readonly MessageStreamEvent[];
  initialTitle: string | null;
  authorizationAllowHosts?: readonly string[];
}) {
  const agent = useStudioAgent({
    headers: () => ({ "x-studio-session-id": appSessionId }),
    initialEvents,
    initialSession: { sessionId: eveSessionId, streamIndex: initialEvents.length },
    resume: true,
    followSubagents: true,
  });

  return (
    <ChatPanel
      authorizationAllowHosts={authorizationAllowHosts}
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

function LoadError({ text, onRetry }: { text: string; onRetry: () => void }) {
  return (
    <div className="mx-auto flex w-full max-w-3xl items-start p-6">
      <Alert variant="destructive">
        <AlertTitle>Не удалось открыть беседу</AlertTitle>
        <AlertDescription>
          <p>{text}</p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" onClick={onRetry}>Повторить</Button>
            <ButtonLink href="/s" size="sm" variant="link">
              Начать новую сессию
            </ButtonLink>
          </div>
        </AlertDescription>
      </Alert>
    </div>
  );
}

export interface ResumedChatProps {
  authorizationAllowHosts?: readonly string[];
  appSessionId: string;
  initialEveSessionId: string | null;
  /** Название с сервера. Пока пустое, шапка спросит его после первого сообщения. */
  initialTitle: string | null;
  /** На момент SSR сервер ещё ждёт привязки сессии eve. */
  starting: boolean;
}

/**
 * Страница беседы: пока история не загружена, чат не монтируется — хук
 * `useStudioAgent` читает `initialEvents` и `initialSession` при создании
 * хранилища, то есть на первом рендере.
 */
export function ResumedChat({
  appSessionId,
  initialEveSessionId,
  initialTitle,
  starting,
  authorizationAllowHosts,
}: ResumedChatProps) {
  const [eveSessionId, setEveSessionId] = useState<string | null>(initialEveSessionId);
  const [phase, setPhase] = useState<Phase>(
    initialEveSessionId !== null ? "loading" : starting ? "starting" : "empty",
  );
  const [events, setEvents] = useState<readonly MessageStreamEvent[]>([]);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (phase !== "starting") return;
    const controller = new AbortController();
    const { signal } = controller;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const poll = async () => {
      try {
        const response = await fetchForResume(`/api/sessions/${appSessionId}`, signal);
        if (!response.ok) throw new Error("Статус сессии недоступен.");
        const body = (await response.json()) as { eveSessionId?: unknown; starting?: unknown };
        if (signal.aborted) return;

        if (typeof body.eveSessionId === "string" && body.eveSessionId !== "") {
          setEveSessionId(body.eveSessionId);
          setPhase("loading");
        } else if (body.eveSessionId === null && body.starting === true) {
          timer = setTimeout(poll, START_POLL_MS);
        } else if (body.eveSessionId === null && body.starting === false) {
          setPhase("empty");
        } else {
          throw new Error("Некорректный статус сессии.");
        }
      } catch {
        if (signal.aborted) return;
        setError("Не удалось проверить статус первой отправки. Попробуйте ещё раз.");
        setPhase("error");
      }
    };

    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [appSessionId, phase]);

  useEffect(() => {
    if (phase !== "loading" || eveSessionId === null) return;
    const controller = new AbortController();

    const load = async () => {
      try {
        const loaded = await loadAllEvents(appSessionId, controller.signal);
        if (controller.signal.aborted) return;
        setEvents(loaded);
        setPhase("ready");
      } catch {
        if (controller.signal.aborted) return;
        setError("Не удалось загрузить историю беседы. Попробуйте ещё раз.");
        setPhase("error");
      }
    };

    void load();
    return () => controller.abort();
  }, [appSessionId, eveSessionId, phase]);

  return (
    <ChatFrame>
      {phase === "starting" ? <StatusScreen text="Сообщение отправляется…" /> : null}
      {phase === "loading" ? <StatusScreen text="Загружаем беседу…" /> : null}
      {phase === "error" ? (
        <LoadError text={error ?? "Неизвестная ошибка."}
          onRetry={() => setPhase(eveSessionId === null ? "starting" : "loading")} />
      ) : null}
      {phase === "empty" ? (
        <ChatWithSession appSessionId={appSessionId} initialTitle={initialTitle} authorizationAllowHosts={authorizationAllowHosts} />
      ) : null}
      {phase === "ready" && eveSessionId !== null ? (
        <ResumedChatSession
          authorizationAllowHosts={authorizationAllowHosts}
          appSessionId={appSessionId}
          eveSessionId={eveSessionId}
          initialEvents={events}
          initialTitle={initialTitle}
        />
      ) : null}
    </ChatFrame>
  );
}
