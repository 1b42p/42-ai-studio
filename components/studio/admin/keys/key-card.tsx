"use client";

import { PowerIcon, PowerOffIcon, RefreshCwIcon, Trash2Icon } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress, ProgressLabel } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import type { AdminKeyDefaults, AdminKeyView } from "@/lib/admin/key-view";
import { USAGE_ERROR_SUFFIX, USAGE_ERROR_TEXT, remainingSandboxesWarning } from "@/lib/admin/key-view";
import { amountLabel, clockTime, fitsLabel, quotaLevel, relativeTime, sandboxesLabel } from "./format";

export interface KeyCardProps {
  readonly item: AdminKeyView;
  readonly defaults: AdminKeyDefaults;
  readonly refreshing: boolean;
  readonly highlighted: boolean;
  readonly now: Date | null;
  readonly timeZone: string;
  readonly onRefresh: () => void;
  readonly onDisable: () => void;
  readonly onEnable: () => void;
  readonly onDelete: () => void;
}

function barClass(level: "ok" | "warning" | "destructive"): string | undefined {
  if (level === "destructive") return "bg-destructive";
  if (level === "warning") return "bg-warning";
  return undefined;
}

function UsageBar({
  label,
  used,
  quota,
}: {
  label: string;
  used: number;
  quota: number;
}) {
  const level = quotaLevel(used, quota);
  return (
    <Progress
      aria-label={label}
      data-level={level}
      indicatorClassName={barClass(level)}
      max={quota}
      value={used}
    >
      <ProgressLabel>{label}</ProgressLabel>
    </Progress>
  );
}

/** Карточка ключа: числа и действия приходят свойствами, запросов нет. */
export function KeyCard({
  item,
  defaults,
  refreshing,
  highlighted,
  now,
  timeZone,
  onRefresh,
  onDisable,
  onEnable,
  onDelete,
}: KeyCardProps) {
  const usage = item.usage;
  const numbers = usage?.cpu != null && usage.memoryGb != null && usage.diskGb != null;
  const exhausted =
    item.exhaustedUntil !== null &&
    now !== null &&
    new Date(item.exhaustedUntil).getTime() > now.getTime();

  return (
    <Card
      className="min-w-0 data-highlighted:ring-2 data-highlighted:ring-primary"
      data-highlighted={highlighted ? "" : undefined}
      data-key-id={item.id}
    >
      <CardHeader className="gap-2">
        <div className="flex min-w-0 items-start justify-between gap-2">
          <CardTitle className="min-w-0 truncate">{item.label}</CardTitle>
          <Button
            aria-label={`Обновить ${item.label}`}
            disabled={refreshing}
            onClick={onRefresh}
            size="icon"
            variant="ghost"
          >
            {refreshing ? <Spinner /> : <RefreshCwIcon />}
          </Button>
        </div>
        <div className="flex flex-wrap gap-1">
          <Badge variant={item.enabled ? "default" : "secondary"}>
            {item.enabled ? "Включён" : "Отключён"}
          </Badge>
          {item.order !== null ? <Badge variant="outline">№ {item.order}</Badge> : null}
          {exhausted && item.exhaustedUntil !== null ? (
            <Badge variant="destructive">
              Квота исчерпана до {clockTime(new Date(item.exhaustedUntil), timeZone)}
            </Badge>
          ) : null}
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {item.warning !== null ? (
          <Alert>
            <AlertDescription>{item.warning}</AlertDescription>
          </Alert>
        ) : null}
        {numbers && usage?.cpu && usage.memoryGb && usage.diskGb ? (
          <div className="flex flex-col gap-2">
            <UsageBar label={amountLabel("vCPU", usage.cpu.used, usage.cpu.quota, "")} quota={usage.cpu.quota} used={usage.cpu.used} />
            <UsageBar
              label={amountLabel("Память", usage.memoryGb.used, usage.memoryGb.quota, "ГиБ")}
              quota={usage.memoryGb.quota}
              used={usage.memoryGb.used}
            />
            <UsageBar
              label={amountLabel("Диск", usage.diskGb.used, usage.diskGb.quota, "ГиБ")}
              quota={usage.diskGb.quota}
              used={usage.diskGb.used}
            />
          </div>
        ) : refreshing ? (
          <div className="flex flex-col gap-2">
            <p className="text-sm text-muted-foreground">Использование ещё не читалось</p>
            <Skeleton className="h-8 w-full" />
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Использование ещё не читалось</p>
        )}
        {usage?.error != null ? (
          <Alert>
            <AlertDescription>
              {USAGE_ERROR_TEXT[usage.error]} {USAGE_ERROR_SUFFIX}
            </AlertDescription>
          </Alert>
        ) : null}
        {item.fits !== null ? (
          <p className="text-sm">{fitsLabel(item.fits, defaults)}</p>
        ) : null}
        <p className="text-sm">{sandboxesLabel(item)}</p>
        {usage?.maxPerSandbox != null ? (
          <p className="text-sm text-muted-foreground">
            Максимум на песочницу: {usage.maxPerSandbox.cpu ?? "—"} vCPU / {usage.maxPerSandbox.memoryGb ?? "—"} ГиБ / {usage.maxPerSandbox.diskGb ?? "—"} ГиБ
          </p>
        ) : null}
        {usage?.organizationId != null || usage?.region != null ? (
          <p className="truncate text-sm text-muted-foreground">
            Организация: {usage.organizationId ?? "—"}, регион: {usage.region ?? "—"}
          </p>
        ) : null}
        {usage?.fetchedAt != null && now !== null ? (
          <p className="text-sm text-muted-foreground">
            Данные получены: {relativeTime(new Date(usage.fetchedAt), now)}
          </p>
        ) : null}
        {item.remainingSandboxes != null && item.remainingSandboxes > 0 ? (
          <Alert variant="destructive">
            <AlertDescription>{remainingSandboxesWarning(item.remainingSandboxes)}</AlertDescription>
          </Alert>
        ) : null}
        <div className="flex flex-wrap gap-2">
          {item.enabled ? (
            <Button aria-label={`Отключить ${item.label}`} onClick={onDisable} variant="outline">
              <PowerOffIcon data-icon="inline-start" />
              Отключить
            </Button>
          ) : (
            <Button aria-label={`Включить ${item.label}`} onClick={onEnable} variant="outline">
              <PowerIcon data-icon="inline-start" />
              Включить
            </Button>
          )}
          <Button aria-label={`Удалить ${item.label}`} onClick={onDelete} variant="destructive">
            <Trash2Icon data-icon="inline-start" />
            Удалить
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
