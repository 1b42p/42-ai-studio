"use client";

import { AlertCircleIcon, BanIcon, CircleCheckIcon, Trash2Icon } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Spinner } from "@/components/ui/spinner";
import type { AdminUserItem } from "@/lib/admin/types";
import type { UserActionState } from "./use-user-actions";

export interface BlockUserDialogProps {
  open: boolean;
  user: AdminUserItem | null;
  blocked: boolean;
  state: UserActionState;
  onClose: () => void;
  onConfirm: () => void;
}

/** Блокировка и разблокировка: управляемое представление без запросов. */
export function BlockUserDialog({
  open,
  user,
  blocked,
  state,
  onClose,
  onConfirm,
}: BlockUserDialogProps) {
  const pending = state.status === "pending";
  const failed = state.status === "error";
  const name = user?.name ?? "";

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next, details) => {
        if (pending) details.cancel();
        else if (!next) onClose();
      }}
    >
      <AlertDialogContent aria-busy={pending}>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {blocked ? "Заблокировать" : "Разблокировать"} {name}?
          </AlertDialogTitle>
          <AlertDialogDescription>
            {blocked
              ? "Пользователь не сможет войти и продолжить работу в сессиях. Его данные сохранятся. Уже идущий ход агента завершится."
              : "Пользователь снова сможет войти."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {failed ? (
          <Alert variant="destructive">
            <AlertCircleIcon />
            <AlertDescription>{state.message}</AlertDescription>
          </Alert>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Отмена</AlertDialogCancel>
          <AlertDialogAction
            aria-label={failed ? "Повторить" : blocked ? "Заблокировать" : "Разблокировать"}
            disabled={pending}
            onClick={onConfirm}
          >
            {pending ? (
              <Spinner aria-label="Выполняется" data-icon="inline-start" />
            ) : failed ? (
              <Trash2Icon data-icon="inline-start" />
            ) : blocked ? (
              <BanIcon data-icon="inline-start" />
            ) : (
              <CircleCheckIcon data-icon="inline-start" />
            )}
            {failed ? "Повторить" : blocked ? "Заблокировать" : "Разблокировать"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
