"use client";

import type { UserContent } from "ai";
import { ArrowUpIcon, PaperclipIcon, SquareIcon } from "lucide-react";
import { useRef, useState } from "react";

import { isBusyStatus, type ChatStatus } from "@/components/studio/chat/chat-status";
import { AttachmentCard } from "@/components/studio/chat/attachment-card";
import { messageContent, type AttachmentsController } from "@/components/studio/chat/attachments";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AttachmentGroup } from "@/components/ui/attachment";
import { Button } from "@/components/ui/button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "@/components/ui/input-group";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/** На сенсорном вводе Enter переносит строку, отправляет кнопка. */
function isTouchInput(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia("(pointer: coarse)").matches;
}

export interface ChatComposerProps {
  status: ChatStatus;
  /** Поле заблокировано, пока грузится история или сессия недоступна. */
  disabled?: boolean;
  /** Загрузчик вложений; без него скрепки и предпросмотра нет. */
  attachments?: AttachmentsController;
  onSend: (content: string | UserContent) => void | Promise<void>;
  onCancel: () => void | Promise<void>;
}

/**
 * Поле ввода беседы: Enter отправляет, Shift+Enter переносит строку,
 * во время хода отправка — поправка к заданию. Скрепка прикладывает файлы,
 * вставка из буфера и перетаскивание работают на всей беседе.
 */
export function ChatComposer({
  status,
  disabled = false,
  attachments,
  onSend,
  onCancel,
}: ChatComposerProps) {
  const [text, setText] = useState("");
  const [cancelPending, setCancelPending] = useState(false);
  const [cancelError, setCancelError] = useState<string>();
  const fileInput = useRef<HTMLInputElement>(null);

  const busy = isBusyStatus(status);
  const resuming = status === "resuming";
  const inputDisabled = disabled || resuming;
  const uploading = attachments?.blocking === true;
  const hasFiles = (attachments?.items.length ?? 0) > 0;
  const canSend = (text.trim().length > 0 || hasFiles) && !inputDisabled && !uploading;

  const submit = async () => {
    const value = text.trim();
    if (inputDisabled || uploading) return;
    if (value.length === 0 && !hasFiles) return;

    const content = messageContent(value, attachments?.items ?? []);
    setText("");
    try {
      await onSend(content);
      attachments?.clear();
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
      <input
        aria-hidden="true"
        className="sr-only"
        data-testid="attachment-file-input"
        multiple
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          event.target.value = "";
          attachments?.addFiles(files);
        }}
        ref={fileInput}
        tabIndex={-1}
        type="file"
      />
      {hasFiles || attachments?.notice !== undefined ? (
        <div className="mb-2 flex flex-col gap-2">
          {attachments !== undefined && attachments.items.length > 0 ? (
            <AttachmentGroup>
              {attachments.items.map((item) => (
                <AttachmentCard
                  item={item}
                  key={item.id}
                  onRemove={attachments.remove}
                  onRetry={attachments.retry}
                />
              ))}
            </AttachmentGroup>
          ) : null}
          {attachments?.notice === undefined ? null : (
            <Alert variant="destructive">
              <AlertDescription>{attachments.notice}</AlertDescription>
            </Alert>
          )}
        </div>
      ) : null}

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
          onPaste={(event) => {
            const files = Array.from(event.clipboardData.files);
            if (files.length === 0 || attachments === undefined) return;
            // Если в буфере только файлы, текст вставлять нечего.
            if (event.clipboardData.getData("text/plain").length === 0) {
              event.preventDefault();
            }
            attachments.addFiles(files);
          }}
          placeholder={placeholder}
          rows={1}
          value={text}
        />
        <InputGroupAddon align="block-end">
          <InputGroupButton
            aria-label="Прикрепить файлы"
            disabled={inputDisabled || attachments === undefined}
            onClick={() => fileInput.current?.click()}
            size="icon-sm"
            variant="ghost"
          >
            <PaperclipIcon />
          </InputGroupButton>
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
          <Tooltip>
            <TooltipTrigger
              disabled={!uploading}
              render={<span className="ml-auto inline-flex" tabIndex={uploading ? 0 : -1} />}
            >
              <InputGroupButton
                aria-label="Отправить"
                disabled={!canSend}
                size="icon-sm"
                type="submit"
                variant="default"
              >
                <ArrowUpIcon />
              </InputGroupButton>
            </TooltipTrigger>
            <TooltipContent>Дождитесь окончания загрузки</TooltipContent>
          </Tooltip>
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
