"use client";

import { RefreshCwIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Item, ItemContent, ItemDescription, ItemGroup } from "@/components/ui/item";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { AdminSandboxesResponse } from "@/lib/admin/resource-types";
import { formatDuration, formatWaiting, ResourceCounter, ResourceEmpty, ResourceUser } from "./shared";

const needs = { create: "Создание", wake: "Пробуждение", restore: "Восстановление" };
const reasons = { capacity: "Нет места", own_session_busy: "Идёт другая сессия пользователя" };
type Running = AdminSandboxesResponse["running"][number];

function Busy({ item }: { item: Running }) {
  return (
    <div className="flex flex-wrap gap-1">
      <Badge variant="outline">{item.state === "starting" ? "Запускается" : "Работает"}</Badge>
      {item.busy ? <Badge variant="secondary" title="Идёт ход или фоновая команда; диспетчер не остановит песочницу">Занята</Badge> : null}
    </div>
  );
}

function activity(value: string, now: number, ready: boolean) {
  if (!ready) return "—";
  const minutes = Math.max(0, Math.floor((now - Date.parse(value)) / 60_000));
  return new Intl.RelativeTimeFormat("ru-RU", { numeric: "auto", style: "short" })
    .format(-minutes, "minute");
}

export function SandboxesView({ data, refreshing, onRefresh, timeZone }: {
  data: AdminSandboxesResponse;
  refreshing: boolean;
  onRefresh: () => void;
  timeZone: string | null;
}) {
  const now = Date.parse(data.generatedAt);
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {([
          ["running", "Запущено"], ["stopped", "Остановлено"],
          ["archived", "В архиве"], ["queued", "В очереди"],
        ] as const).map(([key, title]) => (
          <ResourceCounter key={key} title={title} value={new Intl.NumberFormat("ru-RU").format(data.counts[key])} />
        ))}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm text-muted-foreground">
          Обновлено в {timeZone ? new Intl.DateTimeFormat("ru-RU", {
            timeZone, hour: "2-digit", minute: "2-digit", second: "2-digit",
          }).format(now) : "—"}
        </span>
        <Button variant="outline" size="sm" onClick={onRefresh} disabled={refreshing}>
          <RefreshCwIcon data-icon="inline-start" />Обновить
        </Button>
      </div>
      <Card className="min-w-0">
        <CardHeader><CardTitle>Запущенные песочницы</CardTitle></CardHeader>
        <CardContent className="min-w-0">
          {data.running.length === 0 ? <ResourceEmpty>Запущенных песочниц нет</ResourceEmpty> : (
            <>
              <div className="hidden md:block">
                <Table aria-label="Запущенные песочницы" className="table-fixed">
                  <TableHeader><TableRow>
                    <TableHead className="w-[23%]">Пользователь</TableHead>
                    <TableHead className="w-[13%]">Сессия</TableHead>
                    <TableHead className="w-[14%]">Ключ</TableHead>
                    <TableHead className="w-[20%]">Состояние</TableHead>
                    <TableHead className="w-[15%]">Работает</TableHead>
                    <TableHead className="w-[15%]">Активность</TableHead>
                  </TableRow></TableHeader>
                  <TableBody>{data.running.map((item) => (
                    <TableRow key={item.appSessionId}>
                      <TableCell><ResourceUser user={item.user} /></TableCell>
                      <TableCell>#{item.sessionRef}</TableCell>
                      <TableCell className="truncate" title={item.keyLabel}>{item.keyLabel}</TableCell>
                      <TableCell><Busy item={item} /></TableCell>
                      <TableCell className="whitespace-normal">{formatDuration(item.runningSeconds)}</TableCell>
                      <TableCell className="whitespace-normal">{activity(item.lastActiveAt, now, timeZone !== null)}</TableCell>
                    </TableRow>
                  ))}</TableBody>
                </Table>
              </div>
              <ItemGroup aria-label="Запущенные песочницы" className="md:hidden">{data.running.map((item) => (
                <Item key={item.appSessionId} variant="outline">
                  <ItemContent className="min-w-0">
                    <ResourceUser user={item.user} />
                    <ItemDescription>Сессия: #{item.sessionRef}</ItemDescription>
                    <ItemDescription className="truncate" title={item.keyLabel}>Ключ: {item.keyLabel}</ItemDescription>
                    <Busy item={item} />
                    <ItemDescription>Работает: {formatDuration(item.runningSeconds)}</ItemDescription>
                    <ItemDescription>Активность: {activity(item.lastActiveAt, now, timeZone !== null)}</ItemDescription>
                  </ItemContent>
                </Item>
              ))}</ItemGroup>
            </>
          )}
        </CardContent>
      </Card>
      <Card className="min-w-0">
        <CardHeader><CardTitle>Очередь</CardTitle></CardHeader>
        <CardContent className="min-w-0">
          {data.queue.length === 0 ? <ResourceEmpty>Очередь пуста</ResourceEmpty> : (
            <>
              <div className="hidden md:block">
                <Table aria-label="Очередь" className="table-fixed">
                  <TableHeader><TableRow>
                    <TableHead className="w-[7%]">Место</TableHead>
                    <TableHead className="w-[20%]">Пользователь</TableHead>
                    <TableHead className="w-[13%]">Сессия</TableHead>
                    <TableHead className="w-[10%]">Ждёт</TableHead>
                    <TableHead className="w-[16%]">Что нужно</TableHead>
                    <TableHead className="w-[22%]">Причина</TableHead>
                    <TableHead className="w-[12%]">Ключ</TableHead>
                  </TableRow></TableHeader>
                  <TableBody>{data.queue.map((item) => (
                    <TableRow key={item.appSessionId}>
                      <TableCell>{new Intl.NumberFormat("ru-RU").format(item.position)}</TableCell>
                      <TableCell><ResourceUser user={item.user} /></TableCell>
                      <TableCell>#{item.sessionRef}</TableCell>
                      <TableCell>{formatWaiting(item.waitingSeconds)}</TableCell>
                      <TableCell className="whitespace-normal">{needs[item.need]}</TableCell>
                      <TableCell className="whitespace-normal">{reasons[item.reason]}</TableCell>
                      <TableCell className="truncate" title={item.keyLabel ?? undefined}>{item.keyLabel ?? "—"}</TableCell>
                    </TableRow>
                  ))}</TableBody>
                </Table>
              </div>
              <ItemGroup aria-label="Очередь" className="md:hidden">{data.queue.map((item) => (
                <Item key={item.appSessionId} variant="outline">
                  <ItemContent className="min-w-0">
                    <ResourceUser user={item.user} />
                    <ItemDescription>Место: {item.position} · Сессия: #{item.sessionRef}</ItemDescription>
                    <ItemDescription>Ждёт: {formatWaiting(item.waitingSeconds)}</ItemDescription>
                    <ItemDescription>Что нужно: {needs[item.need]}</ItemDescription>
                    <ItemDescription className="line-clamp-none">Причина: {reasons[item.reason]}</ItemDescription>
                    <ItemDescription className="truncate">Ключ: {item.keyLabel ?? "—"}</ItemDescription>
                  </ItemContent>
                </Item>
              ))}</ItemGroup>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
