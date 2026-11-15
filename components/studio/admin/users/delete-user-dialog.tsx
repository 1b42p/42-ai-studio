"use client";

import { AlertCircleIcon, Trash2Icon } from "lucide-react";
import { useEffect, useState } from "react";

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
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import type { AdminUserItem } from "@/lib/admin/types";
import type { UserActionState } from "./use-user-actions";

export interface DeleteUserDialogProps {
  open: boolean;
  user: AdminUserItem | null;
  state: UserActionState;
  onClose: () => void;
  onConfirm: () => void;
}

/** Удаление: поле подтверждения Telegram ID и прогресс пачек удаления. */
export function DeleteUserDialog({
  open,
  user,
  state,
  onClose,
  onConfirm,
}: DeleteUserDialogProps) {
  const [confirmation, setConfirmation] = useState("");
  const pending = state.status === "pending";
  const failed = state.status === "error";
  const progress = state.status === "pending" ? state.progress : undefined;
  const match = user !== null && confirmation.trim() === user.telegramId;
  const label = user?.deletionRequestedAt !== null && user?.deletionRequestedAt !== undefined
    ? "Продолжить удаление"
    : "Удалить";

  useEffect(() => {
    if (!open) setConfirmation("");
  }, [open]);

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
            Удалить {user?.name ?? ""} со всеми данными?
          </AlertDialogTitle>
          <AlertDialogDescription>
            Будут безвозвратно удалены его сессии, переписка, загруженные файлы, ролики и
            песочницы. Это действие нельзя отменить.
          </AlertDialogDescription>
        </AlertDialogHeader>

        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="admin-delete-confirmation">
              Введите Telegram ID пользователя для подтверждения
            </FieldLabel>
            <Input
              autoComplete="off"
              disabled={pending}
              id="admin-delete-confirmation"
              inputMode="numeric"
              onChange={(event) => setConfirmation(event.target.value)}
              value={confirmation}
            />
          </Field>
        </FieldGroup>

        {progress !== undefined ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner aria-label="Удаление" />
            Удалено сессий: {progress.deleted} из {progress.total}
          </p>
        ) : null}

        {failed ? (
          <Alert variant="destructive">
            <AlertCircleIcon />
            <AlertDescription>{state.message}</AlertDescription>
          </Alert>
        ) : null}

        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Отмена</AlertDialogCancel>
          <AlertDialogAction
            aria-label={failed ? "Повторить" : label}
            disabled={pending || !match}
            onClick={onConfirm}
            variant="destructive"
          >
            {pending ? (
              <Spinner aria-label="Удаление" data-icon="inline-start" />
            ) : (
              <Trash2Icon data-icon="inline-start" />
            )}
            {failed ? "Повторить" : label}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
