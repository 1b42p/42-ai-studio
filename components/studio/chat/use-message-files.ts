"use client";

import type { MessageStreamEvent } from "eve/client";
import type { ConversationState, EveMessage } from "eve/react";
import { useEffect, useMemo, useRef, useState } from "react";

import { isBusyStatus, type ChatStatus } from "@/components/studio/chat/chat-status";
import type { MessageFilesState } from "@/components/studio/chat/message-files";
import { messageIdOf } from "@/lib/media/message-id";
import type { MessageFileView, MessageFilesResponse } from "@/lib/media/types";

const POLL_INTERVAL_MS = 1000;
/** Дольше 10 минут список не опрашивается. */
const POLL_LIMIT_MS = 10 * 60 * 1000;
/** При минимальном опросе после `message.completed`. */
const MIN_POLL_MS = 3000;
/** Сколько сообщение считается «идущим» после конца хода. */
const PENDING_AFTER_TURN_MS = 15_000;

/** Идентификаторы сообщений хода: `<turnId>:<stepIndex>` каждого текста. */
export function messageIdsInTurn(
  messages: readonly EveMessage[],
  turnId: string,
): string[] {
  const ids: string[] = [];
  for (const message of messages) {
    if (message.metadata?.turnId !== turnId) continue;
    for (const part of message.parts) {
      if (part.type !== "text") continue;
      const id = messageIdOf(turnId, part.stepIndex);
      if (id !== undefined) ids.push(id);
    }
  }
  return ids;
}

export interface UseMessageFilesOptions {
  appSessionId: string | null;
  events: readonly MessageStreamEvent[];
  messages: ConversationState["messages"];
  status: ChatStatus;
}

/**
 * Файлы беседы из `/api/sessions/:id/files` (#8): список читается при
 * открытии страницы и повторяется раз в секунду после `message.completed`,
 * пока идёт ход или есть `copying`, но не дольше 10 минут.
 */
export function useMessageFiles({
  appSessionId,
  events,
  messages,
  status,
}: UseMessageFilesOptions): MessageFilesState {
  const [entries, setEntries] = useState<MessageFileView[]>([]);
  const [pendingTurnId, setPendingTurnId] = useState<string | null>(null);

  const busy = isBusyStatus(status);
  const lastTurnId = messages.at(-1)?.metadata?.turnId;
  const completedCount = useMemo(
    () => events.filter((event) => event.type === "message.completed").length,
    [events],
  );

  const entriesRef = useRef(entries);
  const busyRef = useRef(busy);
  const filesUrl =
    appSessionId === null ? null : `/api/sessions/${appSessionId}/files`;

  useEffect(() => {
    entriesRef.current = entries;
  }, [entries]);

  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);

  // Первое чтение при открытии страницы.
  useEffect(() => {
    if (filesUrl === null) {
      setEntries([]);
      return;
    }
    const controller = new AbortController();
    void fetch(filesUrl, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) return;
        const body = (await response.json()) as MessageFilesResponse;
        setEntries(body.files);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [filesUrl]);

  // Повтор после завершения блока сообщения, пока копирование идёт.
  useEffect(() => {
    if (filesUrl === null || completedCount === 0) return;

    const controller = new AbortController();
    const startedAt = Date.now();
    const deadline = startedAt + POLL_LIMIT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;

    const load = async () => {
      try {
        const response = await fetch(filesUrl, {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) return;
        const body = (await response.json()) as MessageFilesResponse;
        if (!cancelled) setEntries(body.files);
      } catch {
        // Сеть пропала: следующий тик повторит.
      }
    };

    const tick = async () => {
      await load();
      if (cancelled || Date.now() >= deadline) return;
      const copying = entriesRef.current.some((entry) => entry.state === "copying");
      const warm = Date.now() - startedAt < MIN_POLL_MS;
      if (!busyRef.current && !copying && !warm) return;
      timer = setTimeout(tick, POLL_INTERVAL_MS);
    };

    timer = setTimeout(tick, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      controller.abort();
      clearTimeout(timer);
    };
  }, [filesUrl, completedCount]);

  // Во время хода строки может ещё не быть: это скелет, а не «не найдено».
  useEffect(() => {
    if (busy && lastTurnId !== undefined) setPendingTurnId(lastTurnId);
  }, [busy, lastTurnId]);

  useEffect(() => {
    if (busy || pendingTurnId === null) return;
    const timer = setTimeout(() => setPendingTurnId(null), PENDING_AFTER_TURN_MS);
    return () => clearTimeout(timer);
  }, [busy, pendingTurnId]);

  const pendingMessageIds = useMemo(
    () => (pendingTurnId === null ? [] : messageIdsInTurn(messages, pendingTurnId)),
    [messages, pendingTurnId],
  );

  return useMemo(
    () => ({ entries, pendingMessageIds }),
    [entries, pendingMessageIds],
  );
}
