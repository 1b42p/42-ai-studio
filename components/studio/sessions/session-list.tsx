"use client";

import {
  AlertCircleIcon,
  ChevronDownIcon,
  ClapperboardIcon,
  SearchIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { SessionsEmptyState } from "@/components/studio/sessions-empty-state";
import { DeleteSessionButton } from "@/components/studio/sessions/delete-session-button";
import { DeleteSessionDialog } from "@/components/studio/sessions/delete-session-dialog";
import { useSessionDeletion } from "@/components/studio/sessions/use-session-deletion";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Empty, EmptyContent, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { formatSessionDate } from "@/lib/sessions/format-date";

export interface SessionListItem {
  readonly id: string;
  readonly title: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SessionListPage {
  readonly items: readonly SessionListItem[];
  readonly nextCursor: string | null;
}

export interface SessionListQuery {
  readonly q: string;
  readonly cursor?: string;
}

const SEARCH_DELAY_MS = 300;

/**
 * Адрес поиска меняется без перехода: подменённый Next.js `replaceState`
 * восстановил бы маршрут и размонтировал чат.
 */
function replaceSearchQuery(query: string): void {
  const url = new URL(window.location.href);
  if (query === "") url.searchParams.delete("q");
  else url.searchParams.set("q", query);
  History.prototype.replaceState.call(
    window.history,
    window.history.state,
    "",
    `${url.pathname}${url.search}${url.hash}`,
  );
}

export async function fetchSessionPage(input: SessionListQuery): Promise<SessionListPage> {
  const params = new URLSearchParams();
  if (input.q !== "") params.set("q", input.q);
  if (input.cursor !== undefined && input.cursor !== "") params.set("cursor", input.cursor);
  const query = params.toString();
  const response = await fetch(query === "" ? "/api/sessions" : `/api/sessions?${query}`);
  if (!response.ok) throw new Error("Не удалось загрузить сессии");
  return (await response.json()) as SessionListPage;
}

function SessionWhen({
  value,
  now,
  timeZone,
}: {
  value: string;
  now?: Date;
  timeZone?: string;
}) {
  const [text, setText] = useState("");

  useEffect(() => {
    const zone = timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    setText(formatSessionDate(new Date(value), now ?? new Date(), zone));
  }, [now, timeZone, value]);

  return <ItemDescription>{text}</ItemDescription>;
}

export interface SessionListProps {
  initialPage: SessionListPage;
  initialQuery: string;
  /** Первая страница не собралась: показываем ошибку, а не пустой список. */
  initialError?: boolean;
  request: (input: SessionListQuery) => Promise<SessionListPage>;
  /** Подмена DELETE для отрисовки без сервера; штатный запрос — в контроллере. */
  deleteRequest?: (id: string) => Promise<void>;
  /** Для проверок. Страница не передаёт: берётся текущий момент и пояс браузера. */
  now?: Date;
  timeZone?: string;
}

/**
 * Список сессий под полем нового сообщения. Сам сеть не выбирает:
 * запрос передают снаружи, чтобы отрисовку можно было проверить без сервера.
 * Номер поколения отбрасывает ответ, который пришёл позже более нового.
 */
export function SessionList({
  initialPage,
  initialQuery,
  initialError = false,
  request,
  deleteRequest,
  now,
  timeZone,
}: SessionListProps) {
  const [queryInput, setQueryInput] = useState(initialQuery);
  const [appliedQuery, setAppliedQuery] = useState(initialQuery);
  const [items, setItems] = useState<readonly SessionListItem[]>(initialError ? [] : initialPage.items);
  const [nextCursor, setNextCursor] = useState<string | null>(
    initialError ? null : initialPage.nextCursor,
  );
  const [status, setStatus] = useState<"idle" | "loading" | "error">(initialError ? "error" : "idle");
  const [purpose, setPurpose] = useState<"search" | "more">("search");
  const requestRef = useRef(request);
  requestRef.current = request;
  const generation = useRef(0);
  // Не возвращаем удалённую строку из ответа поиска, начатого до удаления.
  const deletedIds = useRef(new Set<string>());
  const deleteFocus = useRef<HTMLElement | null>(null);
  const deletion = useSessionDeletion({
    request: deleteRequest,
    onDeleted(id) {
      deletedIds.current.add(id);
      setItems((previous) => previous.filter((item) => item.id !== id));
    },
  });

  const load = (query: string, cursor: string | undefined, nextPurpose: "search" | "more") => {
    const current = generation.current + 1;
    generation.current = current;
    setStatus("loading");
    setPurpose(nextPurpose);
    if (nextPurpose === "search") {
      setItems([]);
      setNextCursor(null);
      setAppliedQuery(query);
      replaceSearchQuery(query);
    }

    void requestRef
      .current({ q: query, cursor })
      .then((page) => {
        if (generation.current !== current) return;
        const visible = page.items.filter((item) => !deletedIds.current.has(item.id));
        setItems((currentItems) =>
          nextPurpose === "more" ? [...currentItems, ...visible] : visible,
        );
        setNextCursor(page.nextCursor);
        setStatus("idle");
      })
      .catch(() => {
        if (generation.current !== current) return;
        setStatus("error");
      });
  };

  useEffect(() => {
    const trimmed = queryInput.trim();
    if (trimmed === appliedQuery) return;
    const handle = window.setTimeout(() => {
      load(trimmed, undefined, "search");
    }, SEARCH_DELAY_MS);
    return () => window.clearTimeout(handle);
  }, [appliedQuery, queryInput]);

  const clearSearch = () => {
    setQueryInput("");
    load("", undefined, "search");
  };

  const loadMore = () => {
    if (nextCursor === null || status === "loading") return;
    load(appliedQuery, nextCursor, "more");
  };

  const retry = () => {
    if (purpose === "more" && nextCursor !== null) load(appliedQuery, nextCursor, "more");
    else load(appliedQuery, undefined, "search");
  };

  const showSearch =
    items.length > 0 || queryInput !== "" || appliedQuery !== "" || status === "loading";
  const searching = status === "loading" && purpose === "search";

  return (
    <section aria-label="Сессии" className="mx-auto flex w-full max-w-3xl flex-col gap-3 px-4 py-4 md:px-6">
      <h2 className="text-sm font-medium">Сессии</h2>
      {showSearch ? (
        <InputGroup>
          <InputGroupAddon>
            <SearchIcon />
          </InputGroupAddon>
          <InputGroupInput
            aria-label="Поиск по названиям"
            onChange={(event) => setQueryInput(event.target.value)}
            value={queryInput}
          />
          {queryInput === "" ? null : (
            <InputGroupAddon align="inline-end">
              <InputGroupButton aria-label="Очистить поиск" onClick={clearSearch} size="icon-xs">
                <XIcon />
              </InputGroupButton>
            </InputGroupAddon>
          )}
        </InputGroup>
      ) : null}

      {searching ? (
        <div className="flex flex-col gap-3">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : null}

      {!searching && items.length > 0 ? (
        <ItemGroup>
          {items.map((item) => (
            <Item className="flex-nowrap" key={item.id} role="listitem">
              <Item
                className="min-w-0 flex-1 flex-nowrap p-0"
                render={<a href={`/s/${item.id}`} />}
              >
                <ItemMedia
                  className="aspect-video w-24 rounded-md bg-muted md:w-40"
                  variant="icon"
                >
                  <ClapperboardIcon />
                </ItemMedia>
                <ItemContent className="min-w-0">
                  <ItemTitle className="line-clamp-none w-full min-w-0 truncate">
                    {item.title ?? "Без названия"}
                  </ItemTitle>
                  <SessionWhen now={now} timeZone={timeZone} value={item.updatedAt} />
                </ItemContent>
              </Item>
              <ItemActions>
                <DeleteSessionButton
                  title={item.title ?? "Без названия"}
                  onClick={() => {
                    deleteFocus.current = document.activeElement as HTMLElement;
                    deletion.open({ id: item.id, title: item.title ?? "Без названия" });
                  }}
                />
              </ItemActions>
            </Item>
          ))}
        </ItemGroup>
      ) : null}

      {!searching && status !== "error" && items.length === 0 && appliedQuery === "" ? (
        <SessionsEmptyState />
      ) : null}

      {!searching && status !== "error" && items.length === 0 && appliedQuery !== "" ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>Ничего не найдено по запросу «{appliedQuery}»</EmptyTitle>
          </EmptyHeader>
          <EmptyContent>
            <Button onClick={clearSearch} type="button" variant="outline">
              Сбросить поиск
            </Button>
          </EmptyContent>
        </Empty>
      ) : null}

      {status === "error" ? (
        <Alert variant="destructive">
          <AlertCircleIcon />
          <AlertTitle>Не удалось загрузить сессии</AlertTitle>
          <AlertDescription>
            <Button onClick={retry} size="sm" type="button" variant="outline">
              Повторить
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}

      {status === "loading" && purpose === "more" ? <Spinner /> : null}
      {nextCursor !== null && !(status === "loading" && purpose === "more") ? (
        <Button onClick={loadMore} type="button" variant="outline">
          <ChevronDownIcon data-icon="inline-start" />
          Показать ещё
        </Button>
      ) : null}
      <DeleteSessionDialog
        finalFocus={deleteFocus}
        onClose={deletion.close}
        onConfirm={() => void deletion.confirm()}
        open={deletion.target !== null}
        state={deletion.state}
        title={deletion.target?.title ?? ""}
      />
    </section>
  );
}
