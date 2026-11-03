"use client";

import { CopyIcon } from "lucide-react";
import { useState } from "react";

import {
  copyDescription,
  copyStatusText,
  copyTitle,
  copyConversationState,
  readCopyCall,
  type CopyCall,
} from "@/components/studio/chat/agent-copy";
import { buildFileLookup } from "@/components/studio/chat/message-files";
import { MessageRow } from "@/components/studio/chat/message-row";
import type { ToolCardProps } from "@/components/studio/chat/tool-card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import {
  TraceDescription,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from "@/components/ui/trace";
import { useIsMobile } from "@/hooks/use-mobile";

/**
 * Файлы песочницы в панели копии не разрешаются: путь выводится текстом.
 * Файлы показывает корневой агент (#8, режим «без файлов»).
 */
const COPY_FILES = buildFileLookup({ enabled: false, entries: [] });

/** Первые две строки задания: остальное — в панели. */
function taskPreview(task: string): string {
  return task.split("\n").slice(0, 2).join("\n");
}

function CopySkeleton() {
  return (
    <div aria-label="Ход копии загружается" className="flex flex-col gap-2">
      <Skeleton className="h-4 w-2/3" />
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-4/5" />
    </div>
  );
}

function CopyBody({ copy, appSessionId }: { copy: CopyCall; appSessionId?: string | null }) {
  const state = copyConversationState(copy);

  if (state === "unavailable") {
    return (
      <Alert>
        <AlertTitle>Ход копии недоступен</AlertTitle>
        <AlertDescription className="whitespace-pre-wrap">
          {copy.output.trim().length === 0
            ? "Поток копии уже недоступен в eve."
            : copy.output}
        </AlertDescription>
      </Alert>
    );
  }

  const conversation =
    copy.observation?.status === "following" ||
    copy.observation?.status === "idle" ||
    copy.observation?.status === "unavailable"
      ? copy.observation.conversation
      : undefined;

  if (conversation === undefined || state === "loading") return <CopySkeleton />;
  if (conversation.messages.length === 0) return <CopySkeleton />;

  return (
    <MessageScrollerProvider autoScroll>
      <MessageScroller className="min-h-0 flex-1">
        <MessageScrollerViewport>
          <MessageScrollerContent className="gap-4 pb-4">
            {conversation.messages.map((message) => (
              <MessageScrollerItem
                key={message.id}
                messageId={message.id}
                scrollAnchor={message.role === "user"}
              >
                <MessageRow
                  appSessionId={appSessionId}
                  data={conversation}
                  files={COPY_FILES}
                  message={message}
                />
              </MessageScrollerItem>
            ))}
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <MessageScrollerButton />
      </MessageScroller>
    </MessageScrollerProvider>
  );
}

/**
 * Карточка копии агента (#12). Вся строка — одна кнопка: по нажатию или с
 * клавиатуры открывается боковая панель с ходом копии.
 *
 * На компьютере панель не модальная и без затемнения: основной чат остаётся
 * рабочим, а закрывают её кнопка и Escape. На телефоне она модальная, занимает
 * весь экран и закрывается ещё и нажатием вне панели.
 */
export function AgentCopyCard({ part, data, appSessionId, onCopyPanelChange }: ToolCardProps) {
  const copy = readCopyCall(data, part);
  const [open, setOpen] = useState(false);
  const mobile = useIsMobile();
  const description = copyDescription(copy);
  const lineStatus =
    copy.status === "running" || copy.status === "starting"
      ? "running"
      : copy.status === "failed"
        ? "error"
        : undefined;

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        onCopyPanelChange?.(part.toolCallId, next);
      }}
      modal={mobile}
      // Base UI закрывает не модальное окно при уходе фокуса: без этого клик
      // в поле ввода чата закрывал бы панель.
      disablePointerDismissal={!mobile}
    >
      <SheetTrigger>
        <TraceLine status={lineStatus}>
          <TraceIcon>
            <CopyIcon />
          </TraceIcon>
          <TraceTitle>{copyTitle(copy)}</TraceTitle>
          {description === null ? null : (
            <TraceDescription className="truncate basis-0 grow">{description}</TraceDescription>
          )}
        </TraceLine>
      </SheetTrigger>
      <SheetContent overlay={mobile} size="panel" className="overflow-hidden">
        <SheetHeader className="gap-1 border-b">
          <SheetTitle>Копия агента</SheetTitle>
          <SheetDescription>{copyStatusText(copy)}</SheetDescription>
        </SheetHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-3 px-4">
          {copy.task.trim().length === 0 ? null : (
            <div className="flex shrink-0 flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">Задача</span>
              <p className="text-sm whitespace-pre-line">{taskPreview(copy.task)}</p>
            </div>
          )}

          {copy.status === "failed" && copy.error.trim().length > 0 ? (
            <Alert className="shrink-0" variant="destructive">
              <AlertTitle>Копия завершилась ошибкой</AlertTitle>
              <AlertDescription className="whitespace-pre-wrap">{copy.error}</AlertDescription>
            </Alert>
          ) : null}

          <CopyBody appSessionId={appSessionId} copy={copy} />
        </div>
      </SheetContent>
    </Sheet>
  );
}
