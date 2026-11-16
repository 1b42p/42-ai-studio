"use client";

import { AlertCircleIcon } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { ItemContent, ItemDescription, ItemTitle } from "@/components/ui/item";
import { Skeleton } from "@/components/ui/skeleton";
import type { AdminResourceUser } from "@/lib/admin/resource-types";

const integer = new Intl.NumberFormat("ru-RU");
const decimal = new Intl.NumberFormat("ru-RU", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

export const formatTokens = (value: number) =>
  value >= 1_000_000 ? `${decimal.format(value / 1_000_000)} млн` : integer.format(value);
export const formatHours = (seconds: number) => `${decimal.format(seconds / 3600)} ч`;
export function formatDuration(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  return minutes >= 60
    ? `${integer.format(Math.floor(minutes / 60))} ч ${String(minutes % 60).padStart(2, "0")} мин`
    : `${integer.format(minutes)} мин`;
}
export const formatWaiting = (seconds: number) =>
  `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;

/** Browser-dependent formatting starts only after hydration. */
export function useBrowserTimeZone(override?: string) {
  const [zone, setZone] = useState<string | null>(null);
  useEffect(() => {
    setZone(override ?? Intl.DateTimeFormat().resolvedOptions().timeZone);
  }, [override]);
  return zone;
}

export function ResourceUser({
  user,
  href = `/admin/users?userId=${user.id}`,
}: {
  user: AdminResourceUser;
  href?: string;
}) {
  return (
    <ItemContent className="min-w-0">
      <ItemTitle className="block w-full truncate" title={user.name}>
        <a href={href}>{user.name}</a>
      </ItemTitle>
      <ItemDescription className="truncate">{user.username ? `@${user.username}` : "Нет @username"}</ItemDescription>
    </ItemContent>
  );
}

export function ResourceCounter({ title, value, description }: {
  title: string;
  value: ReactNode;
  description?: ReactNode;
}) {
  return (
    <Card size="sm" className="min-w-0">
      <CardHeader>
        <CardDescription>{title}</CardDescription>
        <CardTitle className="tabular-nums">{value}</CardTitle>
      </CardHeader>
      {description ? <CardContent>{description}</CardContent> : null}
    </Card>
  );
}

export function ResourceEmpty({ children }: { children: ReactNode }) {
  return <Empty><EmptyHeader><EmptyTitle>{children}</EmptyTitle></EmptyHeader></Empty>;
}

export function ResourceLoading() {
  return (
    <div aria-label="Загрузка данных" role="status" className="flex flex-col gap-3">
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-24 w-full" />
    </div>
  );
}

export function ResourceError({ onRetry }: { onRetry: () => void }) {
  return (
    <Alert variant="destructive">
      <AlertCircleIcon />
      <AlertTitle>Не удалось загрузить данные</AlertTitle>
      <AlertDescription>
        <Button onClick={onRetry} variant="outline" size="sm">Повторить</Button>
      </AlertDescription>
    </Alert>
  );
}
