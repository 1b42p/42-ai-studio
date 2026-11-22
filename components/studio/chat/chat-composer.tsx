"use client";

import type { UserContent } from "ai";
import { ArrowUpIcon, PaperclipIcon, SquareIcon, WandSparklesIcon } from "lucide-react";
import { useContext, useRef, useState } from "react";
import { ChatDraftIdentityContext } from "./draft-identity";

import { useTextDraft, useUnsavedChangesWarning } from "@/components/studio/use-text-draft";

import { isTouchInput } from "@/components/studio/chat/keyboard";
import { isBusyStatus, type ChatStatus } from "@/components/studio/chat/chat-status";
import { AttachmentCard } from "@/components/studio/chat/attachment-card";
import { messageContent, type AttachmentsController, type PendingAttachment } from "@/components/studio/chat/attachments";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { AttachmentGroup } from "@/components/ui/attachment";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
  InputGroupText,
} from "@/components/ui/input-group";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export interface ChatComposerProps {
  appSessionId?: string | null;
  status: ChatStatus;
  /** Поле заблокировано, пока грузится история или сессия недоступна. */
  disabled?: boolean;
  placeholder?: string;
  /** The wrapper already displays the more specific network/session error. */
  hasExternalError?: boolean;
  /** Загрузчик вложений; без него скрепки и предпросмотра нет. */
  attachments?: AttachmentsController;
  onSend: (content: string | UserContent) => void | Promise<void>;
  onCancel: () => void | Promise<void>;
}

export { ChatDraftIdentityContext } from "./draft-identity";

interface Submission {
  readonly text: string;
  readonly items: readonly PendingAttachment[];
  readonly userId: string | null;
  readonly sessionId: string | null;
  readonly recovered?: boolean;
}

/**
 * Поле ввода беседы: Enter отправляет, Shift+Enter переносит строку,
 * во время хода отправка — поправка к заданию. Скрепка прикладывает файлы,
 * вставка из буфера и перетаскивание работают на всей беседе.
 */
export function ChatComposer({
  appSessionId = null,
  status,
  disabled = false,
  placeholder: placeholderProp,
  hasExternalError = false,
  attachments,
  onSend,
  onCancel,
}: ChatComposerProps) {
  const userId = useContext(ChatDraftIdentityContext);
  const newDraftKey = userId ? `studio:draft:v1:${userId}:chat:new` : null;
  const draftKey = userId ? `studio:draft:v1:${userId}:chat:${appSessionId ?? "new"}` : null;
  const draft = useTextDraft(draftKey, "", newDraftKey);
  // Text only: the in-flight buffer must survive navigation without replacing
  // the next draft. Binary attachments remain in their existing controller.
  const pendingDraft = useTextDraft(
    draftKey ? `${draftKey}:pending` : null, "",
    newDraftKey ? `${newDraftKey}:pending` : null,
  );
  const text = draft.value;
  const [submission, setSubmission] = useState<Submission | null>(null);
  const [failedSubmission, setFailedSubmission] = useState<Submission | null>(null);
  const [sendError, setSendError] = useState<{ submission: Submission; text: string }>();
  const submitting = useRef<Submission | null>(null);
  const migrations = useRef(new WeakMap<Submission, string>());
  const previousScope = useRef({ userId, appSessionId });
  if (previousScope.current.userId === userId && previousScope.current.appSessionId === null && appSessionId !== null) {
    for (const item of [submission, failedSubmission, sendError?.submission]) {
      if (item?.userId === userId && item.sessionId === null && !migrations.current.has(item)) {
        migrations.current.set(item, appSessionId);
      }
    }
  }
  previousScope.current = { userId, appSessionId };
  const owns = (item: Submission) => {
    const migrated = migrations.current.get(item);
    return item.userId === userId && (migrated !== undefined
      ? migrated === appSessionId
      : item.sessionId === appSessionId);
  };
  const sending = submission !== null && owns(submission);
  const [reattachOwner, setReattachOwner] = useState<{
    userId: string | null; sessionId: string | null; existingFileIds: ReadonlySet<string>;
  } | null>(null);
  const reattaching = reattachOwner?.userId === userId && reattachOwner?.sessionId === appSessionId;
  const [cancelPending, setCancelPending] = useState(false);
  const [cancelError, setCancelError] = useState<string>();
  const fileInput = useRef<HTMLInputElement>(null);
  const latest = useRef({ owns, attachments, draft, pendingDraft });
  latest.current = { owns, attachments, draft, pendingDraft };
  const retrySubmission = failedSubmission && owns(failedSubmission) ? failedSubmission
    : !sending && pendingDraft.value ? {
      text: pendingDraft.value, items: [], userId, sessionId: appSessionId, recovered: true,
    } satisfies Submission : null;
  const heldFiles = new Set((sending ? submission!.items : retrySubmission?.items)?.map((item) => item.id));
  const editableFiles = attachments?.items.filter((item) => !heldFiles.has(item.id)) ?? [];
  const reattachedFiles = reattaching
    ? editableFiles.filter((item) => !reattachOwner!.existingFileIds.has(item.id)) : [];
  const sendErrorText = sendError && owns(sendError.submission) ? sendError.text : undefined;

  const busy = isBusyStatus(status);
  const resuming = status === "resuming";
  const inputDisabled = disabled || resuming;
  const uploading = attachments?.blocking === true;
  const hasFiles = editableFiles.length > 0;
  const canSend = (text.trim().length > 0 || hasFiles) && !inputDisabled && !uploading && !sending && !retrySubmission;
  useUnsavedChangesWarning(
    (attachments?.items.length ?? 0) > 0 || (text.length > 0 && !draft.persisted) ||
    (pendingDraft.value.length > 0 && !pendingDraft.persisted),
  );

  const submit = async (retry?: Submission) => {
    if (inputDisabled || (submitting.current && owns(submitting.current)) || (!retry && (uploading || retrySubmission))) return;
    const snapshot = retry ?? { text, items: editableFiles, userId, sessionId: appSessionId };
    if (!owns(snapshot)) return;
    if (snapshot.text.trim().length === 0 && snapshot.items.length === 0) return;

    const content = messageContent(snapshot.text.trim(), snapshot.items);
    const sentFiles = new Set(snapshot.items.map((item) => item.id));
    submitting.current = snapshot;
    setSubmission(snapshot);
    setFailedSubmission(null);
    setReattachOwner(null);
    setSendError(undefined);
    pendingDraft.setValue(snapshot.text);
    if (!retry) draft.setValue("");
    try {
      await onSend(content);
      pendingDraft.clear("", snapshot.text);
      const current = latest.current;
      if (current.owns(snapshot) && current.attachments) {
        if (current.attachments.items.every((item) => sentFiles.has(item.id))) {
          current.attachments.clear();
        } else {
          for (const item of current.attachments.items) {
            if (sentFiles.has(item.id)) current.attachments.remove(item.id);
          }
        }
      }
    } catch {
      const current = latest.current;
      if (current.owns(snapshot)) {
        const hasNextFiles = current.attachments?.items.some((item) => !sentFiles.has(item.id)) ?? false;
        if (current.draft.getValue() === "" && !hasNextFiles) {
          current.draft.setValue(snapshot.text);
          current.pendingDraft.clear("", snapshot.text);
        } else {
          setFailedSubmission(snapshot);
        }
        setSendError({
          submission: snapshot,
          text: "Не удалось отправить сообщение. Текст и вложения сохранены. Попробуйте ещё раз.",
        });
      }
    } finally {
      if (submitting.current === snapshot) submitting.current = null;
      setSubmission((active) => active === snapshot ? null : active);
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
    : placeholderProp ?? (busy
      ? "Поправка к заданию…"
      : "Напишите задание…");

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

      <InputGroup>
        <InputGroupTextarea
          aria-label="Сообщение агенту"
          className="max-h-40"
          disabled={inputDisabled}
          onChange={(event) => {
            draft.setValue(event.target.value);
            setSendError(undefined);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && !isTouchInput()) {
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
          <InputGroupText>
            <WandSparklesIcon />
            <span className="hidden sm:inline">Агент-видеограф</span>
          </InputGroupText>
          {busy || sending ? (
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
                {sending ? <Spinner /> : <ArrowUpIcon />}
              </InputGroupButton>
            </TooltipTrigger>
            <TooltipContent>Дождитесь окончания загрузки</TooltipContent>
          </Tooltip>
        </InputGroupAddon>
      </InputGroup>
      {sending && submission ? (
        <Alert className="mt-2" role="status">
          <Spinner />
          <AlertDescription>
            Отправляем сообщение. Можно набирать следующее.
            {submission.text ? <p className="line-clamp-3 whitespace-pre-wrap">{submission.text}</p> : null}
            {submission.items.length ? <p>Файлов: {submission.items.length}</p> : null}
          </AlertDescription>
        </Alert>
      ) : retrySubmission ? (
        <Alert className="mt-2" variant="destructive">
          <AlertDescription>
            {retrySubmission.recovered
              ? "Не удалось подтвердить отправку. Проверьте историю беседы перед повтором. Вложения нужно прикрепить заново. Можно повторить только текст или выбрать файлы для повтора."
              : "Предыдущее сообщение не принято. Следующий черновик сохранён отдельно."}
            <p className="line-clamp-3 whitespace-pre-wrap">{retrySubmission.text}</p>
            <div className="flex flex-wrap gap-2">
              {retrySubmission.recovered ? (
                <>
                  <Button type="button" size="sm" variant="outline" disabled={inputDisabled}
                    onClick={() => void submit({ ...retrySubmission, recovered: false, items: [] })}>Повторить только текст</Button>
                  <Button type="button" size="sm" variant="outline" disabled={inputDisabled || !attachments} onClick={() => {
                    if (!reattaching) setReattachOwner({
                      userId, sessionId: appSessionId,
                      existingFileIds: new Set(attachments?.items.map((item) => item.id)),
                    });
                    fileInput.current?.click();
                  }}>Прикрепить файлы к повтору</Button>
                  {reattaching ? (
                    <>
                      <p>Новые файлы будут приложены к повтору. Ранее выбранные файлы и следующий текст останутся отдельным черновиком.</p>
                      <Button type="button" size="sm" variant="outline"
                        disabled={inputDisabled || reattachedFiles.length === 0 || reattachedFiles.some((item) => item.state !== "done")}
                        onClick={() => void submit({ ...retrySubmission, recovered: false, items: [...retrySubmission.items, ...reattachedFiles] })}>
                        Повторить с файлами
                      </Button>
                    </>
                  ) : null}
                </>
              ) : (
                <Button type="button" size="sm" variant="outline" disabled={inputDisabled}
                  onClick={() => void submit(retrySubmission)}>Повторить отправку</Button>
              )}
              <Button type="button" size="sm" variant="ghost" disabled={inputDisabled} onClick={() => {
                pendingDraft.clear();
                for (const item of retrySubmission.items) attachments?.remove(item.id);
                setFailedSubmission(null);
                setReattachOwner(null);
                setSendError(undefined);
              }}>Не отправлять</Button>
            </div>
          </AlertDescription>
        </Alert>
      ) : null}
      {sendErrorText && !hasExternalError && !retrySubmission ? (
        <Alert className="mt-2" variant="destructive">
          <AlertDescription>{sendErrorText}</AlertDescription>
        </Alert>
      ) : null}
      {hasFiles || attachments?.notice !== undefined ? (
        <div className="mt-3 flex flex-col gap-2">
          {attachments !== undefined && editableFiles.length > 0 ? (
            <AttachmentGroup>
              {editableFiles.map((item) => (
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
      {cancelError === undefined ? null : (
        <Alert className="mt-2" variant="destructive">
          <AlertDescription>{cancelError}</AlertDescription>
        </Alert>
      )}
    </form>
  );
}
