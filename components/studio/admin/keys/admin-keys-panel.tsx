"use client";

import { useEffect, useState } from "react";
import { KeyRoundIcon, PlusIcon, RefreshCwIcon } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import type { AdminKeyView, AdminKeysPage } from "@/lib/admin/key-view";
import { remainingSandboxesWarning } from "@/lib/admin/key-view";
import { AddKeyDialog } from "./add-key-dialog";
import { KeyActionDialog, type KeyAction } from "./key-action-dialog";
import { KeyCard } from "./key-card";
import { AdminHeading } from "../admin-heading";

const STALE_MS = 60_000;
const REFRESH_LIMIT = 5;

export interface AdminKeysPanelProps {
  readonly initialPage: AdminKeysPage;
  readonly initialError?: boolean;
  readonly now?: Date;
  readonly timeZone?: string;
  readonly listRequest?: (deleted: boolean) => Promise<AdminKeysPage>;
  readonly createRequest?: (input: { label: string; apiKey: string }) => Promise<AdminKeyView>;
  readonly patchRequest?: (id: string, enabled: boolean) => Promise<AdminKeyView>;
  readonly refreshRequest?: (id: string) => Promise<AdminKeyView>;
  readonly deleteRequest?: (id: string) => Promise<{ remainingSandboxes: number }>;
}

async function readError(response: Response): Promise<string> {
  try {
    const body = await response.json() as { error?: { message?: string } };
    return body.error?.message ?? "Не удалось выполнить запрос.";
  } catch {
    return "Не удалось выполнить запрос.";
  }
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  if (!response.ok) throw new Error(await readError(response));
  return response.json() as Promise<T>;
}

function defaultList(deleted: boolean): Promise<AdminKeysPage> {
  return api(`/api/admin/keys?deleted=${deleted ? "1" : "0"}`);
}

function noEnabled(items: readonly AdminKeyView[]): boolean {
  return items.length > 0 && items.every((item) => !item.enabled);
}

function noCapacity(items: readonly AdminKeyView[]): boolean {
  const enabled = items.filter((item) => item.enabled);
  return enabled.length > 0 && enabled.every((item) => item.fits === 0);
}

async function mapLimited<T>(
  values: readonly T[],
  limit: number,
  run: (value: T) => Promise<void>,
): Promise<void> {
  const queue = [...values];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length > 0) {
      const next = queue.shift();
      if (next === undefined) return;
      await run(next);
    }
  });
  await Promise.all(workers);
}

/** Раздел «Ключи». Запросы подменяются в тестах отрисовки. */
export function AdminKeysPanel({
  initialPage,
  initialError = false,
  now,
  timeZone = "UTC",
  listRequest = defaultList,
  createRequest,
  patchRequest,
  refreshRequest,
  deleteRequest,
}: AdminKeysPanelProps) {
  const [page, setPage] = useState(initialPage);
  const [error, setError] = useState(initialError);
  const [loading, setLoading] = useState(false);
  const [mountedNow, setMountedNow] = useState<Date | null>(now ?? null);
  const [refreshing, setRefreshing] = useState<ReadonlySet<string>>(new Set());
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [addPending, setAddPending] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [action, setAction] = useState<KeyAction | null>(null);
  const [actionItem, setActionItem] = useState<AdminKeyView | null>(null);
  const [actionPending, setActionPending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [deletedOpen, setDeletedOpen] = useState(false);
  const [deleted, setDeleted] = useState<readonly AdminKeyView[] | null>(null);
  const [deletedError, setDeletedError] = useState<string | null>(null);

  useEffect(() => {
    if (now === undefined) setMountedNow(new Date());
  }, [now]);

  async function refreshOne(id: string): Promise<void> {
    const request = refreshRequest ?? ((keyId: string) => api<AdminKeyView>(`/api/admin/keys/${keyId}/refresh`, { method: "POST" }));
    setRefreshing((current) => new Set(current).add(id));
    try {
      const item = await request(id);
      setPage((current) => ({
        ...current,
        items: current.items.map((existing) => existing.id === item.id ? item : existing),
      }));
    } finally {
      setRefreshing((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
    }
  }

  async function refreshMany(ids: readonly string[]): Promise<void> {
    await mapLimited(ids, REFRESH_LIMIT, (id) => refreshOne(id));
  }

  useEffect(() => {
    const clock = now ?? new Date();
    const stale = initialPage.items.filter((item) => {
      if (item.usageCheckedAt === null) return false;
      const age = clock.getTime() - new Date(item.usageCheckedAt).getTime();
      return age > STALE_MS;
    });
    if (stale.length === 0) return;
    void refreshMany(stale.map((item) => item.id));
    // Автообновление только при открытии страницы.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function reload(): Promise<void> {
    setLoading(true);
    setError(false);
    try {
      setPage(await listRequest(false));
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }

  function openAdd(): void {
    setAddError(null);
    setAddOpen(true);
  }

  async function submitAdd(): Promise<void> {
    const request = createRequest ?? ((input: { label: string; apiKey: string }) =>
      api<AdminKeyView>("/api/admin/keys", { method: "POST", body: JSON.stringify(input) }));
    setAddPending(true);
    setAddError(null);
    try {
      const created = await request({ label: label.trim(), apiKey });
      setPage((current) => ({
        ...current,
        items: [...current.items.filter((item) => item.id !== created.id), created],
      }));
      setLabel("");
      setApiKey("");
      setAddOpen(false);
      setHighlightedId(created.id);
    } catch (caught) {
      setAddError(caught instanceof Error ? caught.message : "Не удалось добавить ключ.");
    } finally {
      setAddPending(false);
    }
  }

  function ask(next: KeyAction, item: AdminKeyView): void {
    setAction(next);
    setActionItem(item);
    setActionError(null);
  }

  async function confirmAction(): Promise<void> {
    if (action === null || actionItem === null || actionPending) return;
    setActionPending(true);
    setActionError(null);
    try {
      if (action === "delete") {
        const request = deleteRequest ?? ((id: string) =>
          api<{ remainingSandboxes: number }>(`/api/admin/keys/${id}`, { method: "DELETE" }));
        const result = await request(actionItem.id);
        setPage((current) => ({
          ...current,
          items: current.items.filter((item) => item.id !== actionItem.id),
        }));
        if (result.remainingSandboxes > 0) {
          setDeletedOpen(true);
          setDeleted((current) => [
            ...(current ?? []).filter((item) => item.id !== actionItem.id),
            {
              ...actionItem,
              remainingSandboxes: result.remainingSandboxes,
              enabled: false,
              deletedAt: new Date().toISOString(),
            },
          ]);
        }
      } else {
        const enabled = action === "enable";
        const request = patchRequest ?? ((id: string, value: boolean) =>
          api<AdminKeyView>(`/api/admin/keys/${id}`, {
            method: "PATCH",
            body: JSON.stringify({ enabled: value }),
          }));
        const updated = await request(actionItem.id, enabled);
        setPage((current) => ({
          ...current,
          items: current.items.map((item) => item.id === updated.id ? updated : item),
        }));
      }
      setAction(null);
      setActionItem(null);
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : "Не удалось выполнить действие.");
    } finally {
      setActionPending(false);
    }
  }

  async function loadDeleted(open: boolean): Promise<void> {
    setDeletedOpen(open);
    if (!open || deleted !== null) return;
    try {
      const result = await listRequest(true);
      setDeleted(result.items);
      setDeletedError(null);
    } catch {
      setDeletedError("Не удалось загрузить удалённые ключи.");
    }
  }

  const shownNow = mountedNow;

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <AdminHeading
        title="Ключи Daytona"
        description="Песочницы создаются на ключах по порядку: когда на первом нет места, берётся следующий. Отключённый ключ не получает новых песочниц, а запущенные на нём продолжают работать."
        actions={<>
          <Button onClick={openAdd}>
            <PlusIcon data-icon="inline-start" />
            Добавить ключ
          </Button>
          <Button
            aria-label="Обновить"
            onClick={() => void refreshMany(page.items.map((item) => item.id))}
            variant="outline"
          >
            <RefreshCwIcon data-icon="inline-start" />
            Обновить
          </Button>
        </>}
      />
      {noEnabled(page.items) ? (
        <Alert>
          <AlertDescription>Нет включённых ключей: новые сессии не смогут запустить песочницу.</AlertDescription>
        </Alert>
      ) : null}
      {noCapacity(page.items) ? (
        <Alert>
          <AlertDescription>Свободной квоты нет ни на одном ключе: новые сессии будут ждать в очереди.</AlertDescription>
        </Alert>
      ) : null}
      {loading ? <Skeleton className="h-40 w-full" /> : null}
      {error ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>Не удалось загрузить ключи</EmptyTitle>
          </EmptyHeader>
          <EmptyContent>
            <Button onClick={() => void reload()}>Повторить</Button>
          </EmptyContent>
        </Empty>
      ) : null}
      {!error && !loading && page.items.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <KeyRoundIcon />
            </EmptyMedia>
            <EmptyTitle>Ключей Daytona нет. Без ключа песочницы не создаются.</EmptyTitle>
            <EmptyDescription>Добавьте ключ из панели Daytona.</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button onClick={openAdd}>
              <PlusIcon data-icon="inline-start" />
              Добавить ключ
            </Button>
          </EmptyContent>
        </Empty>
      ) : null}
      <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-2">
        {page.items.map((item) => (
          <KeyCard
            defaults={page.defaults}
            highlighted={highlightedId === item.id}
            item={item}
            key={item.id}
            now={shownNow}
            onDelete={() => ask("delete", item)}
            onDisable={() => ask("disable", item)}
            onEnable={() => ask("enable", item)}
            onRefresh={() => void refreshOne(item.id)}
            refreshing={refreshing.has(item.id)}
            timeZone={timeZone}
          />
        ))}
      </div>
      <Collapsible className="rounded-xl border border-border bg-muted/30 p-3" onOpenChange={(open) => void loadDeleted(open)} open={deletedOpen}>
        <CollapsibleTrigger className="text-sm font-medium" render={<Button variant="ghost" />}>
          Удалённые ключи ({deleted?.length ?? "…"})
        </CollapsibleTrigger>
        <CollapsibleContent className="flex flex-col gap-2 pt-2">
          {deletedError !== null ? <p className="text-sm text-destructive">{deletedError}</p> : null}
          {deleted?.map((item) => (
            <div className="flex min-w-0 flex-col gap-1" key={item.id}>
              <p className="truncate text-sm">
                {item.label}
                {item.deletedAt !== null && shownNow !== null
                  ? `, удалён ${new Intl.DateTimeFormat("ru-RU", { dateStyle: "medium", timeZone }).format(new Date(item.deletedAt))}`
                  : ""}
              </p>
              {item.remainingSandboxes != null && item.remainingSandboxes > 0 ? (
                <Alert variant="destructive">
                  <AlertDescription>{remainingSandboxesWarning(item.remainingSandboxes)}</AlertDescription>
                </Alert>
              ) : null}
            </div>
          ))}
        </CollapsibleContent>
      </Collapsible>
      <AddKeyDialog
        apiKey={apiKey}
        error={addError}
        label={label}
        onApiKeyChange={setApiKey}
        onLabelChange={setLabel}
        onOpenChange={(open) => {
          setAddOpen(open);
          if (!open) {
            setApiKey("");
            setAddError(null);
          }
        }}
        onSubmit={() => void submitAdd()}
        open={addOpen}
        pending={addPending}
      />
      <KeyActionDialog
        action={action}
        error={actionError}
        item={actionItem}
        onClose={() => {
          setAction(null);
          setActionItem(null);
          setActionError(null);
        }}
        onConfirm={() => void confirmAction()}
        open={action !== null}
        pending={actionPending}
      />
    </div>
  );
}
