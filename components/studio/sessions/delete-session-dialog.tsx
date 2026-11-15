"use client";

import { AlertCircleIcon, Trash2Icon } from "lucide-react";
import type { RefObject } from "react";

import type { SessionDeletionState } from "@/components/studio/sessions/use-session-deletion";
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
import { buttonVariants } from "@/components/ui/button";
import { ItemDescription } from "@/components/ui/item";
import { Spinner } from "@/components/ui/spinner";

export interface DeleteSessionDialogProps {
  title: string;
  open: boolean;
  state: SessionDeletionState;
  onClose: () => void;
  onConfirm: () => void;
  finalFocus?: RefObject<HTMLElement | null>;
}

/** Управляемое представление: никаких запросов и собственного состояния удаления. */
export function DeleteSessionDialog({
  title, open, state, onClose, onConfirm, finalFocus,
}: DeleteSessionDialogProps) {
  const pending = state.status === "pending";

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next, details) => {
        if (pending) details.cancel();
        else if (!next) onClose();
      }}
    >
      <AlertDialogContent aria-busy={pending} finalFocus={finalFocus}>
        <AlertDialogHeader>
          <AlertDialogTitle>Удалить сессию?</AlertDialogTitle>
          <AlertDialogDescription>
            Будут удалены переписка, загруженные файлы, ролики и песочница. Это действие нельзя отменить.
          </AlertDialogDescription>
          <ItemDescription className="line-clamp-none w-full truncate" title={title}>
            {title}
          </ItemDescription>
        </AlertDialogHeader>
        {state.status === "error" ? (
          <Alert variant="destructive">
            <AlertCircleIcon />
            <AlertDescription>
              {state.login ? (
                <a className={buttonVariants({ variant: "link", size: "sm" })} href="/login">
                  Войдите снова
                </a>
              ) : state.message}
            </AlertDescription>
          </Alert>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Отмена</AlertDialogCancel>
          <AlertDialogAction
            aria-label={state.status === "error" ? "Повторить" : "Удалить"}
            disabled={pending}
            onClick={onConfirm}
            variant="destructive"
          >
            {pending ? (
              <Spinner aria-label="Удаление" data-icon="inline-start" />
            ) : <Trash2Icon data-icon="inline-start" />}
            {state.status === "error" ? "Повторить" : "Удалить"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
