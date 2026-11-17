"use client";

import { ChevronLeftIcon, ChevronRightIcon, XIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Item, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "@/components/ui/item";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { AdminResourceUser, AdminUsageResponse } from "@/lib/admin/resource-types";
import { formatHours, formatTokens, ResourceCounter, ResourceEmpty, ResourceUser } from "./shared";
import { UsageChart } from "./usage-chart";

type UsageRow = AdminUsageResponse["byUser"][number];

function OpenTime({ seconds }: { seconds: number }) {
  return seconds > 0 ? <span className="text-sm text-muted-foreground">+ ещё идёт: {formatHours(seconds)}</span> : null;
}

export function UsageUserFilter({ user, onReset, resetHref }: {
  user: AdminResourceUser;
  onReset?: () => void;
  resetHref: string;
}) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <Badge variant="secondary" className="max-w-full min-w-0">
        <span className="truncate" title={user.name}>{user.name}</span>
      </Badge>
      {onReset ? (
        <Button variant="ghost" size="sm" onClick={onReset}>
          <XIcon data-icon="inline-start" />Сбросить
        </Button>
      ) : (
        <a className={buttonVariants({ variant: "ghost", size: "sm" })} href={resetHref}>
          <XIcon data-icon="inline-start" />Сбросить
        </a>
      )}
      <a className={buttonVariants({ variant: "link", size: "sm" })}
        href={`/admin/users?userId=${user.id}`}>Профиль пользователя</a>
    </div>
  );
}

export function UsageView({ data, metric, displayedMetric, onMetricChange, userHref, onPageChange, loading, navigationDisabled, search }: {
  data: AdminUsageResponse;
  metric: "sandboxes" | "tokens";
  displayedMetric: "sandboxes" | "tokens";
  onMetricChange: (metric: "sandboxes" | "tokens") => void;
  userHref: (userId: string) => string;
  onPageChange: (page: number) => void;
  loading: boolean;
  navigationDisabled: boolean;
  search: string;
}) {
  const totals = data.totals;
  return (
    <div className="flex min-w-0 flex-col gap-4" aria-busy={loading}>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 [&>div:first-child]:col-span-2 sm:[&>div:first-child]:col-span-1">
        <ResourceCounter title="Время песочниц" value={formatHours(totals.sandboxSeconds)} emphasis
          description={totals.openSandboxSeconds > 0 ? <OpenTime seconds={totals.openSandboxSeconds} /> : undefined} />
        <ResourceCounter title="Входные токены" value={formatTokens(totals.inputTokens)} />
        <ResourceCounter title="Выходные токены" value={formatTokens(totals.outputTokens)} />
      </div>
      <Card className="min-w-0 shadow-none">
        <CardHeader className="flex flex-wrap items-center justify-between gap-3 border-b border-border">
          <CardTitle>По дням</CardTitle>
          <ToggleGroup aria-label="Показатель отчёта" value={[metric]} variant="outline"
            onValueChange={(values) => {
              if (values[0] === "sandboxes" || values[0] === "tokens") onMetricChange(values[0]);
            }}>
            <ToggleGroupItem value="sandboxes" className="text-foreground">Песочницы</ToggleGroupItem>
            <ToggleGroupItem value="tokens" className="text-foreground">Токены</ToggleGroupItem>
          </ToggleGroup>
        </CardHeader>
        <CardContent className="min-w-0">
          <UsageChart days={data.byDay} metric={displayedMetric} />
        </CardContent>
      </Card>
      <Card className="min-w-0 shadow-none">
        <CardHeader className="border-b border-border">
          <CardTitle>По пользователям</CardTitle>
          <CardDescription>
            {displayedMetric === "tokens" ? "По убыванию суммы входных и выходных токенов" : "По убыванию времени песочниц, включая открытые интервалы"}
          </CardDescription>
        </CardHeader>
        <CardContent className="min-w-0" aria-busy={loading}>
          {data.byUser.length === 0 ? <ResourceEmpty>
            {search ? "Пользователи не найдены" : "За этот период расхода нет"}
          </ResourceEmpty> : (
            <UsageUsers rows={data.byUser} userHref={userHref} />
          )}
          <div className="flex flex-wrap items-center justify-between gap-3 pt-3" aria-label="Страницы пользователей">
            <span role="status" className="text-sm text-muted-foreground">
              Страница {data.usersPage.page} из {Math.max(1, Math.ceil(data.usersPage.total / data.usersPage.pageSize))}.
              {" "}Пользователей: {new Intl.NumberFormat("ru-RU").format(data.usersPage.total)}
            </span>
            <div className="flex gap-2">
              <Button variant="outline" disabled={navigationDisabled || data.usersPage.page <= 1}
                onClick={() => onPageChange(data.usersPage.page - 1)}>
                <ChevronLeftIcon data-icon="inline-start" />Назад
              </Button>
              <Button variant="outline"
                disabled={navigationDisabled || data.usersPage.page * data.usersPage.pageSize >= data.usersPage.total}
                onClick={() => onPageChange(data.usersPage.page + 1)}>
                Далее<ChevronRightIcon data-icon="inline-end" />
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function UsageUsers({ rows, userHref }: { rows: UsageRow[]; userHref: (userId: string) => string }) {
  return (
    <>
      <div className="hidden md:block">
        <Table aria-label="Расход по пользователям" className="table-fixed tabular-nums [&_td]:py-4">
          <TableHeader className="bg-muted/50"><TableRow>
            <TableHead className="w-[34%]">Пользователь</TableHead>
            <TableHead className="w-[26%]">Время песочниц</TableHead>
            <TableHead className="w-[20%]">Входные токены</TableHead>
            <TableHead className="w-[20%]">Выходные токены</TableHead>
          </TableRow></TableHeader>
          <TableBody>{rows.map((row) => (
            <TableRow key={row.user.id} className="cursor-pointer"
              onClick={(event) => {
                if ((event.target as HTMLElement).closest("a")) return;
                window.location.assign(userHref(row.user.id));
              }}>
              <TableCell><ResourceUser user={row.user} href={userHref(row.user.id)} /></TableCell>
              <TableCell>
                <div className="flex flex-col gap-1">
                  {formatHours(row.sandboxSeconds)}
                  <OpenTime seconds={row.openSandboxSeconds} />
                </div>
              </TableCell>
              <TableCell>{formatTokens(row.inputTokens)}</TableCell>
              <TableCell>{formatTokens(row.outputTokens)}</TableCell>
            </TableRow>
          ))}</TableBody>
        </Table>
      </div>
      <ItemGroup aria-label="Расход по пользователям" className="md:hidden">{rows.map((row) => (
        <Item key={row.user.id} variant="muted" className="rounded-xl p-4" render={<a href={userHref(row.user.id)} />}>
          <ItemContent className="min-w-0">
            <ItemTitle className="block w-full truncate" title={row.user.name}>{row.user.name}</ItemTitle>
            <ItemDescription className="truncate">{row.user.username ? `@${row.user.username}` : "Нет @username"}</ItemDescription>
            <ItemDescription>Время песочниц: {formatHours(row.sandboxSeconds)}</ItemDescription>
            <OpenTime seconds={row.openSandboxSeconds} />
            <ItemDescription>Входные токены: {formatTokens(row.inputTokens)}</ItemDescription>
            <ItemDescription>Выходные токены: {formatTokens(row.outputTokens)}</ItemDescription>
          </ItemContent>
        </Item>
      ))}</ItemGroup>
    </>
  );
}
