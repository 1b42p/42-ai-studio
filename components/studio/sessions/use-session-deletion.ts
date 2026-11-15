"use client";

import { useRef, useState } from "react";

export interface DeletionTarget {
  readonly id: string;
  readonly title: string;
}

export type SessionDeletionState =
  | { readonly status: "idle" | "pending" }
  | { readonly status: "error"; readonly message: string; readonly login: boolean };

export interface SessionDeletionController {
  readonly target: DeletionTarget | null;
  readonly state: SessionDeletionState;
  open: (target: DeletionTarget) => void;
  close: () => void;
  confirm: () => Promise<void>;
}

const FAILURE_MESSAGE = "Не удалось полностью удалить сессию. Повторите.";

export class SessionDeletionError extends Error {
  constructor(message: string, readonly login = false) {
    super(message);
  }
}

/** Повтор после завершённого удаления возвращает 404: это тоже успех. */
export async function deleteSessionRequest(id: string): Promise<void> {
  const response = await fetch(`/api/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (response.status === 204 || response.status === 404) return;
  if (response.status === 401 || response.status === 403) {
    throw new SessionDeletionError("Войдите снова", true);
  }
  if (response.status === 409) {
    const body: unknown = await response.json().catch(() => null);
    const error = body && typeof body === "object" && "error" in body ? body.error : null;
    const message = error && typeof error === "object" && "message" in error
      ? error.message : null;
    throw new SessionDeletionError(
      typeof message === "string" && message.trim() !== ""
        ? message : "Удаление этой сессии уже выполняется.",
    );
  }
  throw new SessionDeletionError(FAILURE_MESSAGE);
}

export function leaveDeletedSession(): void {
  window.location.assign("/s");
}

/** Запрос запускается только подтверждением, ref блокирует повторный клик сразу. */
export function useSessionDeletion({
  request = deleteSessionRequest,
  onDeleted,
}: {
  request?: (id: string) => Promise<void>;
  onDeleted: (id: string) => void;
}): SessionDeletionController {
  const [target, setTarget] = useState<DeletionTarget | null>(null);
  const [state, setState] = useState<SessionDeletionState>({ status: "idle" });
  const pending = useRef(false);

  return {
    target,
    state,
    open(next) {
      if (pending.current) return;
      setState({ status: "idle" });
      setTarget(next);
    },
    close() {
      if (pending.current) return;
      setTarget(null);
      setState({ status: "idle" });
    },
    async confirm() {
      if (target === null || pending.current) return;
      pending.current = true;
      setState({ status: "pending" });
      try {
        await request(target.id);
      } catch (error) {
        setState({
          status: "error",
          message: error instanceof SessionDeletionError ? error.message : FAILURE_MESSAGE,
          login: error instanceof SessionDeletionError && error.login,
        });
        pending.current = false;
        return;
      }
      pending.current = false;
      setTarget(null);
      setState({ status: "idle" });
      onDeleted(target.id);
    },
  };
}
