"use client";

import { XIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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

export function UsageView({ data, metric, onMetricChange, userHref }: {
  data: AdminUsageResponse;
  metric: "sandboxes" | "tokens";
  onMetricChange: (metric: "sandboxes" | "tokens") => void;
  userHref: (userId: string) => string;
}) {
  const totals = data.totals;
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <ResourceCounter title="Время песочниц" value={formatHours(totals.sandboxSeconds)}
          description={totals.openSandboxSeconds > 0 ? <OpenTime seconds={totals.openSandboxSeconds} /> : undefined} />
        <ResourceCounter title="Входные токены" value={formatTokens(totals.inputTokens)} />
        <ResourceCounter title="Выходные токены" value={formatTokens(totals.outputTokens)} />
      </div>
      <Card className="min-w-0">
        <CardHeader>
          <CardTitle>По дням</CardTitle>
          <ToggleGroup aria-label="Показатель графика" value={[metric]} variant="outline"
            onValueChange={(values) => {
              if (values[0] === "sandboxes" || values[0] === "tokens") onMetricChange(values[0]);
            }}>
            <ToggleGroupItem value="sandboxes">Песочницы</ToggleGroupItem>
            <ToggleGroupItem value="tokens">Токены</ToggleGroupItem>
          </ToggleGroup>
        </CardHeader>
        <CardContent className="min-w-0">
          <UsageChart days={data.byDay} metric={metric} />
        </CardContent>
      </Card>
      <Card className="min-w-0">
        <CardHeader><CardTitle>По пользователям</CardTitle></CardHeader>
        <CardContent className="min-w-0">
          {data.byUser.length === 0 ? <ResourceEmpty>За этот период расхода нет</ResourceEmpty> : (
            <UsageUsers rows={data.byUser} userHref={userHref} />
          )}
          {data.othersCount > 0 ? <p className="pt-3 text-sm text-muted-foreground">
            Ещё пользователей: {new Intl.NumberFormat("ru-RU").format(data.othersCount)}
          </p> : null}
        </CardContent>
      </Card>
    </div>
  );
}

function UsageUsers({ rows, userHref }: { rows: UsageRow[]; userHref: (userId: string) => string }) {
  return (
    <>
      <div className="hidden md:block">
        <Table aria-label="Расход по пользователям" className="table-fixed">
          <TableHeader><TableRow>
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
        <Item key={row.user.id} variant="outline" render={<a href={userHref(row.user.id)} />}>
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
