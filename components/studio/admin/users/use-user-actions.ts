"use client";

import { useRef, useState } from "react";

import type { AdminUserDeleteResponse, AdminUserItem } from "@/lib/admin/types";
import {
  AdminUsersError,
  deleteAdminUser,
  patchAdminUser,
} from "./admin-users-data";

export type UserActionKind = "block" | "unblock" | "delete";

export interface UserActionTarget {
  readonly kind: UserActionKind;
  readonly user: AdminUserItem;
}

export interface UserActionProgress {
  readonly deleted: number;
  readonly total: number;
}

export type UserActionState =
  | { readonly status: "idle" | "pending"; readonly progress?: UserActionProgress }
  | { readonly status: "error"; readonly message: string };

export interface UserActionsController {
  readonly action: UserActionTarget | null;
  readonly state: UserActionState;
  open: (kind: UserActionKind, user: AdminUserItem) => void;
  close: () => void;
  confirm: () => Promise<void>;
}

const FAILURE = "Не удалось выполнить действие. Повторите.";

/**
 * Подтверждение блокировки или удаления. Удаление идёт пачками: ответ 202
 * показывает прогресс и клиент повторяет запрос, пока сервер не ответит 204.
 * Повтор без прогресса (все оставшиеся сессии заняты) не крутится бесконечно.
 */
export function useUserActions({
  blockRequest = patchAdminUser,
  deleteRequest = deleteAdminUser,
  onChanged,
  onDeleted,
}: {
  blockRequest?: (id: string, blocked: boolean) => Promise<AdminUserItem>;
  deleteRequest?: (id: string) => Promise<AdminUserDeleteResponse>;
  onChanged: (updated: AdminUserItem, previous: AdminUserItem) => void;
  onDeleted: (deleted: AdminUserItem) => void;
}): UserActionsController {
  const [action, setAction] = useState<UserActionTarget | null>(null);
  const [state, setState] = useState<UserActionState>({ status: "idle" });
  const pending = useRef(false);

  return {
    action,
    state,
    open(kind, user) {
      if (pending.current) return;
      setState({ status: "idle" });
      setAction({ kind, user });
    },
    close() {
      if (pending.current) return;
      setAction(null);
      setState({ status: "idle" });
    },
    async confirm() {
      if (action === null || pending.current) return;
      pending.current = true;
      setState({ status: "pending" });

      try {
        if (action.kind !== "delete") {
          const updated = await blockRequest(action.user.id, action.kind === "block");
          onChanged(updated, action.user);
          pending.current = false;
          setAction(null);
          setState({ status: "idle" });
          return;
        }

        let previous: AdminUserDeleteResponse | null = null;
        for (let attempt = 0; attempt < 30; attempt += 1) {
          const response = await deleteRequest(action.user.id);
          if (response.done) {
            pending.current = false;
            setAction(null);
            setState({ status: "idle" });
            onDeleted(action.user);
            return;
          }

          setState({
            status: "pending",
            progress: { deleted: response.deleted, total: response.total },
          });
          if (
            previous !== null &&
            !previous.done &&
            response.deleted <= previous.deleted &&
            response.remaining.sessions >= previous.remaining.sessions
          ) {
            throw new AdminUsersError(
              "Удаление продолжается. Попробуйте ещё раз через минуту.",
            );
          }
          previous = response;
        }
        throw new AdminUsersError(
          "Не удалось полностью удалить пользователя. Повторите удаление.",
        );
      } catch (error) {
        setState({
          status: "error",
          message: error instanceof AdminUsersError ? error.message : FAILURE,
        });
      } finally {
        pending.current = false;
      }
    },
  };
}
