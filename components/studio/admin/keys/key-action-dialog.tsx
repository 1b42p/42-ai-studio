"use client";

import { AlertCircleIcon } from "lucide-react";

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
import type { AdminKeyView } from "@/lib/admin/key-view";

export type KeyAction = "disable" | "enable" | "delete";

export interface KeyActionDialogProps {
  readonly open: boolean;
  readonly action: KeyAction | null;
  readonly item: AdminKeyView | null;
  readonly pending: boolean;
  readonly error: string | null;
  readonly onClose: () => void;
  readonly onConfirm: () => void;
}

function copy(action: KeyAction, item: AdminKeyView): { title: string; body: string } {
  if (action === "disable") {
    return {
      title: `Отключить ключ «${item.label}»?`,
      body: "Новые песочницы на нём создаваться не будут. Запущенные и остановленные песочницы на нём продолжат работать.",
    };
  }
  if (action === "enable") {
    return {
      title: `Включить ключ «${item.label}»?`,
      body: "Новые песочницы снова смогут создаваться на нём.",
    };
  }
  const { running, stopped, archived } = item.sandboxes;
  return {
    title: `Удалить ключ «${item.label}»?`,
    body: `Песочницы на нём (запущено ${running}, остановлено ${stopped}, в архиве ${archived}) будут удалены вместе с файлами. Сессии пользователей продолжатся в новых пустых песочницах; переписка и опубликованные файлы сохранятся. Действие нельзя отменить.`,
  };
}

/** Подтверждение отключения, включения и удаления. «Отмена» не вызывает обработчик. */
export function KeyActionDialog({
  open,
  action,
  item,
  pending,
  error,
  onClose,
  onConfirm,
}: KeyActionDialogProps) {
  if (action === null || item === null) return null;
  const text = copy(action, item);

  return (
    <AlertDialog
      onOpenChange={(next) => {
        if (!pending && !next) onClose();
      }}
      open={open}
    >
      <AlertDialogContent className="max-w-[calc(100%-2rem)]">
        <AlertDialogHeader>
          <AlertDialogTitle className="break-all">{text.title}</AlertDialogTitle>
          <AlertDialogDescription>{text.body}</AlertDialogDescription>
        </AlertDialogHeader>
        {error !== null ? (
          <Alert variant="destructive">
            <AlertCircleIcon />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Отмена</AlertDialogCancel>
          <AlertDialogAction
            disabled={pending}
            onClick={onConfirm}
            variant={action === "delete" ? "destructive" : "default"}
          >
            {pending ? <Spinner data-icon="inline-start" /> : null}
            {action === "disable" ? "Отключить" : action === "enable" ? "Включить" : "Удалить"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
