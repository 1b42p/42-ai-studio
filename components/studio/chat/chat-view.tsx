"use client";

import { ClientError, type InputResponse, type MessageStreamEvent } from "eve/client";
import {
  openConversationInputs,
  type ConversationState,
} from "eve/react";
import type { UserContent } from "ai";
import { AlertCircleIcon, ClapperboardIcon, PaperclipIcon, PlusIcon, SquareIcon } from "lucide-react";
import { useMemo, useRef, useState, type DragEvent, type ReactNode } from "react";

import { ChatComposer } from "@/components/studio/chat/chat-composer";
import type { ChatStatus } from "@/components/studio/chat/chat-status";
import type { AttachmentsController } from "@/components/studio/chat/attachments";
import { displayMessages } from "@/components/studio/chat/display-messages";
import {
  buildFileLookup,
  type MessageFilesState,
} from "@/components/studio/chat/message-files";
import { InputPrompt } from "@/components/studio/chat/input-prompt";
import { inlineQuestionIds } from "@/components/studio/chat/input-routing";
import { hasVisibleAssistantContent, MessageRow } from "@/components/studio/chat/message-row";
import { SandboxStatusBanner } from "@/components/studio/chat/sandbox-status-banner";
import { StudioWelcome } from "@/components/studio/chat/studio-welcome";
import { DeleteSessionButton } from "@/components/studio/sessions/delete-session-button";
import { DeleteSessionDialog } from "@/components/studio/sessions/delete-session-dialog";
import type { SessionDeletionController } from "@/components/studio/sessions/use-session-deletion";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { buttonVariants } from "@/components/ui/button";
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { ItemActions } from "@/components/ui/item";
import { Marker, MarkerContent, MarkerIcon } from "@/components/ui/marker";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller";
import { Spinner } from "@/components/ui/spinner";
import { Trace, TraceIcon, TraceLine, TraceTitle } from "@/components/ui/trace";
import { cn } from "@/lib/utils";
import type { SandboxStatus } from "@/lib/sandbox/status";

/** Готовое состояние беседы: компонент не вызывает хук сам. */
export interface ChatViewAgent {
  readonly data: ConversationState;
  readonly events: readonly MessageStreamEvent[];
  readonly status: ChatStatus;
  readonly error?: Error;
}

export interface ChatViewProps {
  agent: ChatViewAgent;
  /** Название беседы в шапке. Пока названия нет — «Новая сессия». */
  title?: string;
  /**
   * Список сессий под полем ввода, пока сообщений нет. Поле остаётся одним
   * узлом и поднимается за счёт `order`, а не второго экземпляра.
   */
  sessions?: ReactNode;
  /** Приглашение, пока сообщений нет и список сессий не показан. */
  emptyTitle?: string;
  emptyDescription?: string;
  /** Поле ввода заблокировано, пока грузится история. */
  inputDisabled?: boolean;
  /** Сессия завершена снаружи (истёк поток, осиротела). */
  ended?: boolean;
  /** Сессия приложения: карточки команд опрашивают задания из неё. */
  appSessionId?: string | null;
  /** Exact HTTP host exceptions supplied by the server in test mode only. */
  authorizationAllowHosts?: readonly string[];
  /** Состояние песочницы приходит от обёртки, без сети внутри представления. */
  sandboxStatus?: SandboxStatus | null;
  /** Файлы из ответов агента; без них ссылки показывают «Файл недоступен». */
  messageFiles?: MessageFilesState;
  /** Загрузчик вложений поля ввода; без него скрепка неактивна. */
  attachments?: AttachmentsController;
  /** Управляемое удаление, запрос исполняется только в контроллере обёртки. */
  sessionDeletion?: SessionDeletionController;
  onSend: (content: string | UserContent) => void | Promise<void>;
  onRespond: (responses: readonly InputResponse[]) => void | Promise<void>;
  onCancel: () => void | Promise<void>;
}

type Notice =
  | { readonly kind: "cancelled" }
  | { readonly kind: "failed"; readonly text: string };

function NoticeRow({ notice }: { notice: Notice }) {
  if (notice.kind === "cancelled") {
    return (
      <Marker>
        <MarkerIcon>
          <SquareIcon />
        </MarkerIcon>
        <MarkerContent>Остановлено</MarkerContent>
      </Marker>
    );
  }

  return (
    <Alert variant="destructive">
      <AlertCircleIcon />
      <AlertTitle>Не удалось получить ответ</AlertTitle>
      <AlertDescription>{notice.text}</AlertDescription>
    </Alert>
  );
}

/** Коды eve, при которых поток уже удалён, а история осталась в базе. */
const EXPIRED_SESSION_CODES: ReadonlySet<string> = new Set([
  "session_expired",
  "session_stranded",
]);

function describeAgentError(
  error: Error,
): { title: string; description: string; href?: string } | null {
  if (error instanceof ClientError) {
    if (error.code !== undefined && EXPIRED_SESSION_CODES.has(error.code)) return null;
    switch (error.code) {
      case "session_already_started":
        return {
          title: "Сессия уже начата",
          description: "Обновите страницу, чтобы увидеть беседу.",
        };
      case "session_forbidden":
        return {
          title: "Сессия недоступна",
          description: "Откройте новую сессию и начните заново.",
          href: "/s",
        };
      case "user_blocked":
        return { title: "Доступ закрыт", description: "Обратитесь к администратору сервиса." };
      default:
        break;
    }
    if (error.status === 401) {
      return { title: "Войдите снова", description: "Сессия входа истекла.", href: "/login" };
    }
  }

  return { title: "Не удалось отправить сообщение", description: error.message };
}

function collectNotices(events: readonly MessageStreamEvent[]): Map<string, Notice[]> {
  const byTurn = new Map<string, Notice[]>();

  for (const event of events) {
    if (event.type === "turn.failed") {
      const notice: Notice = {
        kind: "failed",
        text:
          event.data.code === "MODEL_CALL_FAILED"
            ? "Модель сейчас недоступна. Попробуйте ещё раз."
            : event.data.message,
      };
      const list = byTurn.get(event.data.turnId) ?? [];
      list.push(notice);
      byTurn.set(event.data.turnId, list);
    } else if (event.type === "turn.cancelled") {
      const list = byTurn.get(event.data.turnId) ?? [];
      list.push({ kind: "cancelled" });
      byTurn.set(event.data.turnId, list);
    }
  }

  return byTurn;
}

function sessionEnded(events: readonly MessageStreamEvent[], ended: boolean): boolean {
  return (
    ended ||
    events.some((event) => event.type === "session.failed" || event.type === "session.completed")
  );
}

function isExpired(error: Error | undefined): boolean {
  return (
    error instanceof ClientError &&
    error.code !== undefined &&
    EXPIRED_SESSION_CODES.has(error.code)
  );
}

/**
 * Экран беседы: шапка, лента, открытые запросы ввода и поле ввода.
 * Получает готовое состояние и обработчики свойствами, поэтому его можно
 * отрисовать в тестах по записанным событиям без хука и сети.
 */
export function ChatView({
  agent,
  title = "Новая сессия",
  sessions,
  emptyTitle = "Опишите, какой ролик нужно сделать",
  emptyDescription,
  inputDisabled = false,
  ended = false,
  appSessionId = null,
  authorizationAllowHosts,
  sandboxStatus,
  messageFiles,
  attachments,
  sessionDeletion,
  onSend,
  onRespond,
  onCancel,
}: ChatViewProps) {
  const { data, events, status } = agent;
  const files = useMemo(() => buildFileLookup(messageFiles), [messageFiles]);
  const messages = useMemo(() => displayMessages(data.messages, events), [data.messages, events]);
  const openInputs = openConversationInputs(data);
  const inlineIds = inlineQuestionIds(data);
  const pinnedInputs = openInputs.filter((input) => !inlineIds.has(input.request.requestId));
  const firstInput = openInputs.find((input) => input.request.kind === "session-limit") ?? openInputs[0];
  const firstRequest = firstInput?.request;
  const responseBlocked = firstRequest !== undefined &&
    (firstRequest.kind !== "question" || firstRequest.allowFreeform !== true);
  const responsePlaceholder = firstRequest?.kind === "session-limit"
    ? "Нажмите «Продолжить» или «Остановить»"
    : responseBlocked ? "Выберите вариант выше"
    : firstRequest ? "Ответьте на вопрос агента или напишите своё" : undefined;
  const byTurn = collectNotices(events);
  const finished = sessionEnded(events, ended);
  const expired = isExpired(agent.error);
  const errorNotice = agent.error === undefined || expired ? undefined : describeAgentError(agent.error);
  const resuming = status === "resuming";
  const disabled = inputDisabled || resuming || finished;
  const thinking = status === "submitted" ||
    (status === "streaming" && openInputs.length === 0 && !hasVisibleAssistantContent(messages.at(-1)));
  const showSessions = sessions !== undefined && messages.length === 0;
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const deleteButton = useRef<HTMLButtonElement | null>(null);
  const canAttach = attachments !== undefined && !disabled;
  // Панель копии рисуется поверх окна справа: пока она открыта, лента и поле
  // ввода освобождают её ширину, чтобы прямоугольники не пересекались.
  const [openCopies, setOpenCopies] = useState<ReadonlySet<string>>(new Set());
  const copyPanelOpen = openCopies.size > 0;
  const handleCopyPanelChange = (callId: string, open: boolean) => {
    setOpenCopies((previous) => {
      const next = new Set(previous);
      if (open) next.add(callId);
      else next.delete(callId);
      return next;
    });
  };

  const hasFiles = (event: DragEvent): boolean =>
    event.dataTransfer.types.includes("Files");

  const lastMessageIndexByTurn = new Map<string, number>();
  messages.forEach((message, index) => {
    const turnId = message.metadata?.turnId;
    if (turnId !== undefined) lastMessageIndexByTurn.set(turnId, index);
  });

  const renderedTurns = new Set<string>();

  return (
    <div
      className={cn(
        "relative flex h-full min-h-0 min-w-0 flex-col bg-background transition-[padding] duration-200 motion-reduce:transition-none",
        showSessions && "overflow-y-auto overscroll-y-contain",
        copyPanelOpen && "md:pr-[480px]",
      )}
      onDragEnter={(event) => {
        if (!canAttach || !hasFiles(event)) return;
        event.preventDefault();
        dragDepth.current += 1;
        setDragging(true);
      }}
      onDragLeave={() => {
        if (!canAttach) return;
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setDragging(false);
      }}
      onDragOver={(event) => {
        if (!canAttach || !hasFiles(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      }}
      onDrop={(event) => {
        if (!canAttach || !hasFiles(event)) return;
        event.preventDefault();
        dragDepth.current = 0;
        setDragging(false);
        attachments.addFiles(Array.from(event.dataTransfer.files));
      }}
    >
      {dragging ? (
        <div className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center bg-background/80 p-6">
          <Empty className="border-dashed">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <PaperclipIcon />
              </EmptyMedia>
              <EmptyTitle>Отпустите файлы, чтобы прикрепить</EmptyTitle>
            </EmptyHeader>
          </Empty>
        </div>
      ) : null}
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border/70 bg-card/60 px-4 py-3 md:px-8 md:py-4">
        <div className="flex min-w-0 items-center gap-3">
          <EmptyMedia variant="icon" className="hidden sm:flex">
            <ClapperboardIcon />
          </EmptyMedia>
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="text-[10px] font-medium tracking-[0.16em] text-muted-foreground uppercase">Рабочая студия</span>
            <h1 className="min-w-0 truncate text-sm font-semibold">{title}</h1>
          </div>
        </div>
        <ItemActions className="shrink-0">
          {appSessionId && sessionDeletion ? (
            <DeleteSessionButton
              buttonRef={deleteButton}
              onClick={() => sessionDeletion.open({ id: appSessionId, title })}
              title={title}
            />
          ) : null}
          <a href="/s" className={buttonVariants({ size: "sm", variant: "outline" })}>
            <PlusIcon data-icon="inline-start" />
            Новая сессия
          </a>
        </ItemActions>
      </header>
      {sessionDeletion ? (
        <DeleteSessionDialog
          finalFocus={deleteButton}
          onClose={sessionDeletion.close}
          onConfirm={() => void sessionDeletion.confirm()}
          open={sessionDeletion.target !== null}
          state={sessionDeletion.state}
          title={sessionDeletion.target?.title ?? title}
        />
      ) : null}

      {/* На стартовом экране прокручивается вся студия, а не узкая библиотека
          под закреплённым вступлением. В беседе скроллом владеет MessageScroller.
          `order` сохраняет единственный экземпляр поля при первом сообщении. */}
      <div
        className={cn(
          "flex min-h-0 flex-col",
          showSessions ? "order-3 shrink-0" : "flex-1",
        )}
      >
        {showSessions ? (
          sessions
        ) : (
          <MessageScrollerProvider autoScroll>
        <MessageScroller className="min-h-0 flex-1">
          <MessageScrollerViewport>
            <MessageScrollerContent className="mx-auto w-full max-w-4xl px-4 py-6 md:px-10 md:py-10">
              {messages.length === 0 && !thinking ? (
                <StudioWelcome title={emptyTitle} description={emptyDescription} />
              ) : null}

              {messages.map((message, index) => {
                const turnId = message.metadata?.turnId;
                const notices =
                  turnId !== undefined && lastMessageIndexByTurn.get(turnId) === index
                    ? (byTurn.get(turnId) ?? [])
                    : [];
                if (turnId !== undefined && notices.length > 0) renderedTurns.add(turnId);

                return (
                  <MessageScrollerItem
                    key={message.id}
                    messageId={message.id}
                    scrollAnchor={message.role === "user"}
                  >
                    <div className="flex w-full min-w-0 flex-col gap-3">
                      <MessageRow
                        authorizationAllowHosts={authorizationAllowHosts}
                        appSessionId={appSessionId}
                        data={data}
                        files={files}
                        message={message}
                        onCopyPanelChange={handleCopyPanelChange}
                        onRespond={onRespond}
                        inputDisabled={disabled}
                      />
                      {notices.map((notice, noticeIndex) => (
                        <NoticeRow key={`${message.id}-notice-${noticeIndex}`} notice={notice} />
                      ))}
                    </div>
                  </MessageScrollerItem>
                );
              })}

              {thinking ? (
                <Trace
                  aria-live="polite"
                  role="status"
                >
                  <TraceLine status="running">
                    <TraceIcon><Spinner /></TraceIcon>
                    <TraceTitle>Агент думает…</TraceTitle>
                  </TraceLine>
                </Trace>
              ) : null}

              {[...byTurn.entries()]
                .filter(([turnId]) => !renderedTurns.has(turnId))
                .flatMap(([turnId, notices]) =>
                  notices.map((notice, index) => (
                    <NoticeRow key={`${turnId}-${index}`} notice={notice} />
                  )),
                )}

            </MessageScrollerContent>
          </MessageScrollerViewport>
          <MessageScrollerButton />
        </MessageScroller>
          </MessageScrollerProvider>
        )}
      </div>

      <div
        className={cn(
          "shrink-0 bg-background px-3 pb-3 pt-2 md:px-8 md:pb-5",
          showSessions ? "order-2 border-b border-border/70 pt-6 md:pt-10" : "",
        )}
      >
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-3 md:px-2">
          {errorNotice ? (
            <Alert variant="destructive">
              <AlertCircleIcon />
              <AlertTitle>{errorNotice.title}</AlertTitle>
              <AlertDescription>
                {errorNotice.description}
                {errorNotice.href ? (
                  <a href={errorNotice.href} className={buttonVariants({ variant: "link", size: "sm" })}>
                    {errorNotice.href === "/login" ? "Войти" : "Новая сессия"}
                  </a>
                ) : null}
              </AlertDescription>
            </Alert>
          ) : null}
          {showSessions ? (
            <div className="px-1 pb-3 md:pb-5">
              <StudioWelcome compact />
            </div>
          ) : null}
          {pinnedInputs.map((input) => (
            <InputPrompt disabled={disabled} input={input} key={input.request.requestId} onRespond={onRespond} />
          ))}
          <SandboxStatusBanner status={sandboxStatus} />
          {finished || expired ? (
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm text-muted-foreground">
                {expired ? "История сохранена, но продолжить сессию нельзя" : "Сессия завершена"}
              </span>
              <a href="/s" className={buttonVariants({ size: "sm", variant: "outline" })}>
                Новая сессия
              </a>
            </div>
          ) : (
            <ChatComposer
              appSessionId={appSessionId}
              attachments={attachments}
              disabled={disabled || responseBlocked}
              hasExternalError={errorNotice != null}
              placeholder={responsePlaceholder}
              onCancel={onCancel}
              onSend={async (content) => {
                if (typeof content === "string" && firstRequest?.kind === "question" && firstRequest.allowFreeform) {
                  await onRespond([{ requestId: firstRequest.requestId, text: content }]);
                } else {
                  await onSend(content);
                }
              }}
              status={status}
            />
          )}
        </div>
      </div>
    </div>
  );
}
