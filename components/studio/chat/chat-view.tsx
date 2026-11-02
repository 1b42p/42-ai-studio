"use client";

import { ClientError, type InputResponse, type MessageStreamEvent } from "eve/client";
import {
  openConversationInputs,
  type ConversationInput,
  type ConversationState,
  type EveDynamicToolPart,
  type EveMessage,
  type EveMessagePart,
} from "eve/react";
import {
  AlertCircleIcon,
  BrainIcon,
  CircleCheckIcon,
  SquareIcon,
  VideoIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";

import { ChatComposer } from "@/components/studio/chat/chat-composer";
import type { ChatStatus } from "@/components/studio/chat/chat-status";
import { ChatMarkdown } from "@/components/studio/chat/chat-markdown";
import { ToolCard } from "@/components/studio/chat/tool-card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Item, ItemActions, ItemContent, ItemDescription, ItemTitle } from "@/components/ui/item";
import { Marker, MarkerContent, MarkerIcon } from "@/components/ui/marker";
import { Message, MessageContent } from "@/components/ui/message";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller";
import {
  Questionnaire,
  QuestionnaireActions,
  QuestionnaireChoice,
  QuestionnaireChoices,
  QuestionnaireError,
  QuestionnaireInput,
  QuestionnaireItem,
  QuestionnaireSubmit,
  QuestionnaireTitle,
} from "@/components/ui/questionnaire";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from "@/components/ui/trace";

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
  onSend: (text: string) => void | Promise<void>;
  onRespond: (responses: readonly InputResponse[]) => void | Promise<void>;
  onCancel: () => void | Promise<void>;
}

type AssistantGroup =
  | { readonly kind: "reasoning"; readonly id: string; readonly text: string; readonly running: boolean }
  | { readonly kind: "text"; readonly id: string; readonly text: string; readonly streaming: boolean }
  | { readonly kind: "tools"; readonly id: string; readonly parts: EveDynamicToolPart[] };

type Notice =
  | { readonly kind: "cancelled" }
  | { readonly kind: "failed"; readonly text: string };

function textOfUserMessage(message: EveMessage): string {
  return message.parts
    .filter((part): part is Extract<EveMessagePart, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

/**
 * Подряд идущие размышления сливаются в одну строку, подряд идущие вызовы —
 * в один `Trace`. Пустые размышления не показываются.
 */
function groupAssistantParts(parts: readonly EveMessagePart[]): AssistantGroup[] {
  const groups: AssistantGroup[] = [];

  for (const part of parts) {
    if (part.type === "text") {
      if (part.text.trim().length === 0) continue;
      groups.push({
        kind: "text",
        id: part.id ?? `text-${groups.length}`,
        text: part.text,
        streaming: part.state === "streaming",
      });
      continue;
    }

    if (part.type === "reasoning") {
      if (part.text.trim().length === 0) continue;
      const last = groups.at(-1);
      if (last?.kind === "reasoning") {
        groups[groups.length - 1] = {
          ...last,
          text: last.text + part.text,
          running: last.running || part.state === "streaming",
        };
      } else {
        groups.push({
          kind: "reasoning",
          id: part.id ?? `reasoning-${groups.length}`,
          text: part.text,
          running: part.state === "streaming",
        });
      }
      continue;
    }

    if (part.type === "dynamic-tool") {
      const last = groups.at(-1);
      if (last?.kind === "tools") {
        last.parts.push(part);
      } else {
        groups.push({ kind: "tools", id: part.toolCallId, parts: [part] });
      }
    }
  }

  return groups;
}

function ReasoningRow({ text, running }: { text: string; running: boolean }) {
  return (
    <TraceCollapsible defaultOpen={false}>
      <TraceCollapsibleTrigger>
        <TraceLine status={running ? "running" : undefined}>
          <TraceIcon>
            <BrainIcon />
          </TraceIcon>
          <TraceTitle>Размышление</TraceTitle>
        </TraceLine>
      </TraceCollapsibleTrigger>
      <TraceCollapsibleContent className="whitespace-pre-wrap">{text}</TraceCollapsibleContent>
    </TraceCollapsible>
  );
}

function AssistantContent({ parts }: { parts: readonly EveMessagePart[] }) {
  const groups = groupAssistantParts(parts);

  return (
    <div className="flex w-full min-w-0 flex-col gap-3">
      {groups.map((group) => {
        if (group.kind === "reasoning") {
          return (
            <Trace key={group.id}>
              <ReasoningRow running={group.running} text={group.text} />
            </Trace>
          );
        }

        if (group.kind === "tools") {
          return (
            <Trace key={group.id}>
              {group.parts.map((part) => (
                <ToolCard key={part.toolCallId} part={part} />
              ))}
            </Trace>
          );
        }

        return <ChatMarkdown key={group.id} streaming={group.streaming} text={group.text} />;
      })}
    </div>
  );
}

function MessageRow({ message }: { message: EveMessage }) {
  const align = message.role === "user" ? "end" : "start";

  return (
    <Message align={align}>
      <MessageContent>
        {message.role === "user" ? (
          <Bubble align="end" variant="muted">
            <BubbleContent className="whitespace-pre-wrap">
              {textOfUserMessage(message)}
            </BubbleContent>
          </Bubble>
        ) : (
          <AssistantContent parts={message.parts} />
        )}
      </MessageContent>
    </Message>
  );
}

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

/** Запрос продолжения при пределе расходов у eve английский: переводим по id. */
function localizeRequest(request: ConversationInput["request"]): {
  prompt: string;
  options: ReadonlyArray<{ id: string; label: string; style?: string }>;
} {
  if (request.kind === "session-limit") {
    return {
      prompt: "У сессии закончился лимит расходов. Продолжить работу?",
      options: (request.options ?? []).map((option) => ({
        ...option,
        label:
          option.id === "continue"
            ? "Продолжить"
            : option.id === "stop"
              ? "Остановить"
              : option.label,
      })),
    };
  }

  return { prompt: request.prompt, options: request.options ?? [] };
}

function InputPrompt({
  input,
  disabled,
  onRespond,
}: {
  input: ConversationInput;
  disabled: boolean;
  onRespond: (responses: readonly InputResponse[]) => void | Promise<void>;
}) {
  const { prompt, options } = localizeRequest(input.request);
  const requestId = input.request.requestId;
  const [text, setText] = useState("");

  if (input.request.kind !== "tool-approval") {
    return (
      <Questionnaire
        className="gap-4 rounded-xl border bg-card p-4"
        // Валидация считает недоступные ответы пустыми: заблокированную форму
        // пересоздаём, чтобы ответ восстанавливался из состояния запроса.
        key={disabled ? "locked" : "open"}
        onSubmit={(event) => {
          event.preventDefault();
          if (disabled) return;
          const value = new FormData(event.currentTarget).get(requestId);
          if (typeof value !== "string" || value.trim().length === 0) return;

          const option = options.find((item) => item.id === value);
          void onRespond([
            option === undefined
              ? { requestId, text: value.trim() }
              : { optionId: option.id, requestId },
          ]);
        }}
        shortcuts="numbers"
      >
        <QuestionnaireItem name={requestId} required>
          <QuestionnaireTitle className="text-sm font-medium">{prompt}</QuestionnaireTitle>
          <QuestionnaireChoices>
            {options.map((option) => (
              <QuestionnaireChoice disabled={disabled} key={option.id} value={option.id}>
                {option.label}
              </QuestionnaireChoice>
            ))}
            {input.request.allowFreeform === true || options.length === 0 ? (
              <QuestionnaireInput
                aria-label="Свой ответ"
                disabled={disabled}
                placeholder="Свой ответ"
              />
            ) : null}
          </QuestionnaireChoices>
          <QuestionnaireError />
        </QuestionnaireItem>
        {disabled ? null : (
          <QuestionnaireActions>
            <QuestionnaireSubmit size="sm">Ответить</QuestionnaireSubmit>
          </QuestionnaireActions>
        )}
      </Questionnaire>
    );
  }

  return (
    <Item className="flex-col items-stretch gap-3" size="sm" variant="outline">
      <ItemContent>
        <ItemTitle>Нужно подтверждение</ItemTitle>
        <ItemDescription className="whitespace-pre-wrap">{prompt}</ItemDescription>
      </ItemContent>
      <ItemActions className="justify-start">
        {options.map((option) => (
          <Button
            disabled={disabled}
            key={option.id}
            onClick={() => void onRespond([{ optionId: option.id, requestId }])}
            size="sm"
            variant={
              option.style === "danger"
                ? "destructive"
                : option.style === "primary"
                  ? "default"
                  : "outline"
            }
          >
            {option.label}
          </Button>
        ))}
      </ItemActions>
      {input.request.allowFreeform === true ? (
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const value = text.trim();
            if (value.length === 0 || disabled) return;
            setText("");
            void onRespond([{ requestId, text: value }]);
          }}
        >
          <Input
            aria-label="Свой ответ"
            disabled={disabled}
            onChange={(event) => setText(event.target.value)}
            placeholder="Свой ответ"
            value={text}
          />
          <Button disabled={disabled || text.trim().length === 0} size="sm" type="submit">
            Ответить
          </Button>
        </form>
      ) : null}
    </Item>
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
  onSend,
  onRespond,
  onCancel,
}: ChatViewProps) {
  const { data, events, status } = agent;
  const messages = data.messages;
  const openInputs = openConversationInputs(data);
  const byTurn = collectNotices(events);
  const finished = sessionEnded(events, ended);
  const expired = isExpired(agent.error);
  const errorNotice = agent.error === undefined || expired ? undefined : describeAgentError(agent.error);
  const resuming = status === "resuming";
  const disabled = inputDisabled || resuming || finished;
  const thinking = status === "submitted";
  const showSessions = sessions !== undefined && messages.length === 0;

  const lastMessageIndexByTurn = new Map<string, number>();
  messages.forEach((message, index) => {
    const turnId = message.metadata?.turnId;
    if (turnId !== undefined) lastMessageIndexByTurn.set(turnId, index);
  });

  const renderedTurns = new Set<string>();

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-center justify-between gap-3 border-b px-4 py-3 md:px-6">
        <h1 className="min-w-0 truncate text-sm font-medium">{title}</h1>
        <Button nativeButton={false} size="sm" variant="outline" render={<a href="/s" />}>
          Новая сессия
        </Button>
      </header>

      {/* `order` поднимает поле над списком, не размонтируя его. */}
      <div
        className={cn(
          "flex min-h-0 flex-1 flex-col",
          showSessions && "order-3 overflow-y-auto",
        )}
      >
        {showSessions ? (
          sessions
        ) : (
          <MessageScrollerProvider autoScroll>
        <MessageScroller className="min-h-0 flex-1">
          <MessageScrollerViewport>
            <MessageScrollerContent className="mx-auto w-full max-w-3xl gap-4 px-4 py-6 md:px-6">
              {messages.length === 0 && !thinking ? (
                <Empty className="border-0">
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <VideoIcon />
                    </EmptyMedia>
                    <EmptyTitle>{emptyTitle}</EmptyTitle>
                    {emptyDescription === undefined ? null : (
                      <EmptyDescription>{emptyDescription}</EmptyDescription>
                    )}
                  </EmptyHeader>
                </Empty>
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
                      <MessageRow message={message} />
                      {notices.map((notice, noticeIndex) => (
                        <NoticeRow key={`${message.id}-notice-${noticeIndex}`} notice={notice} />
                      ))}
                    </div>
                  </MessageScrollerItem>
                );
              })}

              {thinking ? (
                <div
                  aria-live="polite"
                  className="flex items-center gap-2 text-sm text-muted-foreground"
                  role="status"
                >
                  <Spinner />
                  <span className="shimmer">Агент думает…</span>
                </div>
              ) : null}

              {[...byTurn.entries()]
                .filter(([turnId]) => !renderedTurns.has(turnId))
                .flatMap(([turnId, notices]) =>
                  notices.map((notice, index) => (
                    <NoticeRow key={`${turnId}-${index}`} notice={notice} />
                  )),
                )}

              {openInputs.map((input) => (
                <InputPrompt
                  disabled={disabled}
                  input={input}
                  key={input.request.requestId}
                  onRespond={onRespond}
                />
              ))}

              {errorNotice === null || errorNotice === undefined ? null : (
                <Alert variant="destructive">
                  <AlertCircleIcon />
                  <AlertTitle>{errorNotice.title}</AlertTitle>
                  <AlertDescription>
                    {errorNotice.description}
                    {errorNotice.href === undefined ? null : (
                      <>
                        {" "}
                        <Button
                          className="h-auto p-0 align-baseline"
                          nativeButton={false}
                          render={<a href={errorNotice.href} />}
                          size="sm"
                          variant="link"
                        >
                          {errorNotice.href === "/login" ? "Войти" : "Новая сессия"}
                        </Button>
                      </>
                    )}
                  </AlertDescription>
                </Alert>
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
          "shrink-0 bg-background px-4 py-3 md:px-6",
          showSessions ? "order-2 border-b" : "border-t",
        )}
      >
        <div className="mx-auto w-full max-w-3xl">
          {finished || expired ? (
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm text-muted-foreground">
                {expired ? "История сохранена, но продолжить сессию нельзя" : "Сессия завершена"}
              </span>
              <Button nativeButton={false} size="sm" variant="outline" render={<a href="/s" />}>
                Новая сессия
              </Button>
            </div>
          ) : (
            <ChatComposer
              disabled={disabled}
              onCancel={onCancel}
              onSend={onSend}
              status={status}
            />
          )}
        </div>
      </div>
    </div>
  );
}
