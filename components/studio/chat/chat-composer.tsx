"use client";

import { ArrowUpIcon, SquareIcon } from "lucide-react";
import { useState } from "react";

import { isBusyStatus, type ChatStatus } from "@/components/studio/chat/chat-status";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "@/components/ui/input-group";
import { Spinner } from "@/components/ui/spinner";

/** На сенсорном вводе Enter переносит строку, отправляет кнопка. */
function isTouchInput(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia("(pointer: coarse)").matches;
}

export interface ChatComposerProps {
  status: ChatStatus;
  /** Поле заблокировано, пока грузится история или сессия недоступна. */
  disabled?: boolean;
  onSend: (text: string) => void | Promise<void>;
  onCancel: () => void | Promise<void>;
}

/**
 * Поле ввода беседы: Enter отправляет, Shift+Enter переносит строку,
 * во время хода отправка — поправка к заданию. Кнопки подписаны для
 * экранных дикторов и содержат только иконки.
 */
export function ChatComposer({ status, disabled = false, onSend, onCancel }: ChatComposerProps) {
  const [text, setText] = useState("");
  const [cancelPending, setCancelPending] = useState(false);
  const [cancelError, setCancelError] = useState<string>();

  const busy = isBusyStatus(status);
  const resuming = status === "resuming";
  const inputDisabled = disabled || resuming;
  const canSend = text.trim().length > 0 && !inputDisabled;

  const submit = async () => {
    const value = text.trim();
    if (value.length === 0 || inputDisabled) return;
    setText("");
    try {
      await onSend(value);
    } catch {
      setText(value);
    }
  };

  const cancel = async () => {
    setCancelError(undefined);
    setCancelPending(true);
    try {
      await onCancel();
    } catch {
      setCancelError("Не удалось остановить ход");
    } finally {
      setCancelPending(false);
    }
  };

  const placeholder = resuming
    ? "Восстанавливаем беседу…"
    : busy
      ? "Поправка к заданию…"
      : "Напишите задание…";

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <InputGroup>
        <InputGroupTextarea
          aria-label="Сообщение агенту"
          className="max-h-36 min-h-10 p-3"
          disabled={inputDisabled}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !isTouchInput()) {
              event.preventDefault();
              void submit();
            }
          }}
          placeholder={placeholder}
          rows={1}
          value={text}
        />
        <InputGroupAddon align="block-end">
          {busy ? (
            <InputGroupButton
              aria-label="Стоп"
              disabled={cancelPending}
              onClick={() => void cancel()}
              size="icon-sm"
              variant="outline"
            >
              {cancelPending ? <Spinner /> : <SquareIcon />}
            </InputGroupButton>
          ) : null}
          <InputGroupButton
            aria-label="Отправить"
            className="ml-auto"
            disabled={!canSend}
            size="icon-sm"
            type="submit"
            variant="default"
          >
            <ArrowUpIcon />
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
      {cancelError === undefined ? null : (
        <Alert className="mt-2" variant="destructive">
          <AlertDescription>{cancelError}</AlertDescription>
        </Alert>
      )}
    </form>
  );
}
