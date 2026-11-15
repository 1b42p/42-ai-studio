"use client";

import {
  AlertCircleIcon,
  ChevronDownIcon,
  SearchIcon,
  UsersIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import type {
  AdminUserDeleteResponse,
  AdminUserItem,
  AdminUsersPage,
  AdminUsersTotals,
} from "@/lib/admin/types";
import { BlockUserDialog } from "./block-user-dialog";
import {
  deleteAdminUser,
  fetchAdminUsers,
  patchAdminUser,
  type AdminUsersQuery,
} from "./admin-users-data";
import { DeleteUserDialog } from "./delete-user-dialog";
import { useUserActions } from "./use-user-actions";
import { UsersList } from "./users-list";

const SEARCH_DELAY_MS = 300;
const EMPTY_TOTALS: AdminUsersTotals = { users: 0, operators: 0, blocked: 0 };

export interface AdminUsersPanelProps {
  readonly initialPage: AdminUsersPage;
  readonly initialUserId?: string | null;
  /** Первая страница не собралась: показываем ошибку, а не пустой список. */
  readonly initialError?: boolean;
  request?: (input: AdminUsersQuery) => Promise<AdminUsersPage>;
  blockRequest?: (id: string, blocked: boolean) => Promise<AdminUserItem>;
  deleteRequest?: (id: string) => Promise<AdminUserDeleteResponse>;
  onResetFilter?: () => void;
  /** Для проверок отрисовки: без них берётся текущий момент и пояс браузера. */
  readonly now?: Date;
  readonly timeZone?: string;
}

/**
 * Раздел «Пользователи»: поиск, постраничная подгрузка и действия. Сеть
 * подменяется свойствами, поэтому список и диалоги проверяются без сервера.
 */
export function AdminUsersPanel({
  initialPage,
  initialUserId = null,
  initialError = false,
  request = fetchAdminUsers,
  blockRequest = patchAdminUser,
  deleteRequest = deleteAdminUser,
  onResetFilter,
  now,
  timeZone,
}: AdminUsersPanelProps) {
  const [queryInput, setQueryInput] = useState("");
  const [appliedQuery, setAppliedQuery] = useState("");
  const [items, setItems] = useState<readonly AdminUserItem[]>(
    initialError ? [] : initialPage.items,
  );
  const [nextCursor, setNextCursor] = useState<string | null>(
    initialError ? null : initialPage.nextCursor,
  );
  const [totals, setTotals] = useState<AdminUsersTotals>(
    initialError ? EMPTY_TOTALS : initialPage.totals,
  );
  const [status, setStatus] = useState<"idle" | "loading" | "error">(
    initialError ? "error" : "idle",
  );
  const [purpose, setPurpose] = useState<"search" | "more">("search");
  const requestRef = useRef(request);
  requestRef.current = request;
  const generation = useRef(0);
  const deletedIds = useRef(new Set<string>());
  const filterUserId = initialUserId;

  const actions = useUserActions({
    blockRequest,
    deleteRequest,
    onChanged(updated, previous) {
      setItems((current) =>
        current.map((item) => (item.id === updated.id ? updated : item)),
      );
      if (updated.isBlocked !== previous.isBlocked) {
        setTotals((current) => ({
          ...current,
          blocked: Math.max(0, current.blocked + (updated.isBlocked ? 1 : -1)),
        }));
      }
    },
    onDeleted(deleted) {
      deletedIds.current.add(deleted.id);
      setItems((current) => current.filter((item) => item.id !== deleted.id));
      setTotals((current) => ({
        ...current,
        users: Math.max(0, current.users - 1),
        blocked: deleted.isBlocked ? Math.max(0, current.blocked - 1) : current.blocked,
      }));
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
    }

    void requestRef
      .current({ q: query, cursor, userId: filterUserId })
      .then((page) => {
        if (generation.current !== current) return;
        const visible = page.items.filter((item) => !deletedIds.current.has(item.id));
        setItems((currentItems) =>
          nextPurpose === "more" ? [...currentItems, ...visible] : visible,
        );
        setNextCursor(page.nextCursor);
        setTotals(page.totals);
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

  const resetFilter =
    onResetFilter ??
    (() => {
      window.location.assign("/admin/users");
    });

  const loadMore = () => {
    if (nextCursor === null || status === "loading") return;
    load(appliedQuery, nextCursor, "more");
  };

  const retry = () => {
    if (purpose === "more" && nextCursor !== null) load(appliedQuery, nextCursor, "more");
    else load(appliedQuery, undefined, "search");
  };

  const searching = status === "loading" && purpose === "search";
  const action = actions.action;
  const blockOpen = action !== null && action.kind !== "delete";
  const deleteOpen = action !== null && action.kind === "delete";

  return (
    <section aria-label="Пользователи" className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-medium">Пользователи</h2>
        <p className="text-sm text-muted-foreground">
          Всего {totals.users} · Операторов {totals.operators} · Заблокировано{" "}
          {totals.blocked}
        </p>
      </div>

      {filterUserId === null ? null : (
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="secondary">Фильтр: пользователь</Badge>
          <Button onClick={resetFilter} size="sm" type="button" variant="ghost">
            <XIcon data-icon="inline-start" />
            Сбросить
          </Button>
        </div>
      )}

      <InputGroup>
        <InputGroupAddon>
          <SearchIcon />
        </InputGroupAddon>
        <InputGroupInput
          aria-label="Поиск по @username и Telegram ID"
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

      {searching ? (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : null}

      {!searching && status !== "error" && items.length > 0 ? (
        <UsersList items={items} now={now} onAction={actions.open} timeZone={timeZone} />
      ) : null}

      {!searching && status !== "error" && items.length === 0 && appliedQuery !== "" ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <UsersIcon />
            </EmptyMedia>
            <EmptyTitle>Никого не найдено по запросу «{appliedQuery}»</EmptyTitle>
          </EmptyHeader>
          <EmptyContent>
            <Button onClick={clearSearch} type="button" variant="outline">
              Сбросить поиск
            </Button>
          </EmptyContent>
        </Empty>
      ) : null}

      {!searching &&
      status !== "error" &&
      items.length === 0 &&
      appliedQuery === "" ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <UsersIcon />
            </EmptyMedia>
            <EmptyTitle>Пользователей пока нет</EmptyTitle>
            <EmptyDescription>
              Пользователь появится здесь после первого входа.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : null}

      {status === "error" ? (
        <Alert variant="destructive">
          <AlertCircleIcon />
          <AlertTitle>Не удалось загрузить пользователей</AlertTitle>
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

      <BlockUserDialog
        blocked={action?.kind === "block"}
        onClose={actions.close}
        onConfirm={() => void actions.confirm()}
        open={blockOpen}
        state={actions.state}
        user={action?.user ?? null}
      />
      <DeleteUserDialog
        onClose={actions.close}
        onConfirm={() => void actions.confirm()}
        open={deleteOpen}
        state={actions.state}
        user={action?.user ?? null}
      />
    </section>
  );
}
