"use client";

import { useEffect, useRef, useState } from "react";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { AdminResourceUser, AdminUsageResponse } from "@/lib/admin/resource-types";
import { validUsageDates } from "@/lib/admin/usage-period";
import { fetchAdminUsage, usagePeriod, type UsageQuery } from "./resource-data";
import { ResourceError, ResourceLoading, useBrowserTimeZone } from "./shared";
import { UsageUserFilter, UsageView } from "./usage-view";
import { AdminHeading } from "../admin-heading";
import { Card, CardContent } from "@/components/ui/card";

const PERIODS = [
  { value: "1", label: "Сегодня" }, { value: "7", label: "7 дней" },
  { value: "30", label: "30 дней" }, { value: "90", label: "90 дней" },
  { value: "custom", label: "Свой период" },
] as const;

interface SavedReport {
  data: AdminUsageResponse;
  metric: "sandboxes" | "tokens";
  search: string;
  key: string | null;
}

export interface AdminUsagePanelProps {
  initialUser?: AdminResourceUser | null;
  initialData?: AdminUsageResponse;
  initialPeriod?: { from: string; to: string };
  request?: (query: UsageQuery, signal?: AbortSignal) => Promise<AdminUsageResponse>;
  timeZone?: string;
  now?: Date;
  onResetFilter?: () => void;
}

export function AdminUsagePanel({
  initialUser = null, initialData, initialPeriod, request = fetchAdminUsage, timeZone, now, onResetFilter,
}: AdminUsagePanelProps) {
  const zone = useBrowserTimeZone(timeZone);
  const [period, setPeriod] = useState(initialPeriod ? "custom" : "7");
  const [custom, setCustom] = useState(initialPeriod ?? { from: "", to: "" });
  const [metric, setMetric] = useState<"sandboxes" | "tokens">("sandboxes");
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  const [pagination, setPagination] = useState({ key: "", page: 1 });
  const [report, setReport] = useState<SavedReport | null>(
    initialData ? { data: initialData, metric: "sandboxes", search: "", key: null } : null,
  );
  const data = report?.data;
  const [loading, setLoading] = useState(!initialData);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const requestRef = useRef(request);
  requestRef.current = request;
  const currentNow = now ?? new Date();
  const range = zone ? period === "custom" ? custom : usagePeriod(Number(period), zone, currentNow) : null;
  const from = range?.from ?? "";
  const to = range?.to ?? "";
  const valid = validUsageDates(from, to);
  const userId = initialUser?.id;
  const pageKey = JSON.stringify([from, to, zone, userId, q, metric]);
  const page = pagination.key === pageKey ? pagination.page : 1;
  const requestKey = JSON.stringify([pageKey, page]);
  const stale = report !== null && (report.key !== requestKey || search.trim() !== q);

  useEffect(() => {
    const timer = setTimeout(() => setQ(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    // Сохраняем только текущий контекст: возврат к прежнему поиску или
    // периоду не должен восстанавливать когда-то открытую страницу.
    setPagination((current) => current.key === pageKey ? current : { key: pageKey, page: 1 });
  }, [pageKey]);

  useEffect(() => {
    if (!zone) return;
    if (!valid) {
      setLoading(false);
      setError(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError(false);
    void requestRef.current({
      from, to, tz: zone, ...(userId ? { userId } : {}),
      ...(q ? { q } : {}), ...(metric === "tokens" ? { metric } : {}),
      ...(page > 1 ? { page } : {}),
    }, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setReport({ data: result, metric, search: q, key: requestKey });
      }).catch(() => {
        if (!controller.signal.aborted) setError(true);
      }).finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [from, to, userId, valid, zone, retry, q, metric, page, requestKey]);

  const href = (id?: string) => {
    const query = new URLSearchParams({ from: data?.period.from ?? from, to: data?.period.to ?? to });
    if (id) query.set("userId", id);
    return `/admin/usage?${query}`;
  };

  return (
    <section aria-label="Расход" className="flex min-w-0 flex-col gap-4">
      <AdminHeading title="Расход" description="Время песочниц считается, пока песочница запущена; остановку самой Daytona по бездействию учитывает приблизительно. Токены — по данным провайдера модели." />
      {initialUser ? <UsageUserFilter user={initialUser} onReset={onResetFilter} resetHref={href()} /> : null}
      <Card className="shadow-none">
        <CardContent>
          <FieldGroup>
            <Field>
              <FieldLabel>Период</FieldLabel>
              <ToggleGroup aria-label="Период" className="w-full flex-wrap justify-start" variant="outline"
                value={[period]} onValueChange={(values) => {
                  const next = values[0];
                  if (!PERIODS.some((item) => item.value === next)) return;
                  if (next === "custom" && custom.from === "" && range) setCustom(range);
                  setPeriod(next);
                }}>
                {PERIODS.map((item) => (
                  <ToggleGroupItem key={item.value} value={item.value} className="text-foreground">{item.label}</ToggleGroupItem>
                ))}
              </ToggleGroup>
              <FieldDescription>Часовой пояс: {zone ?? "определяется…"}</FieldDescription>
            </Field>
            {period === "custom" ? (
              <FieldGroup className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field data-invalid={!valid}>
                  <FieldLabel htmlFor="usage-from">Начало периода</FieldLabel>
                  <Input id="usage-from" type="date" value={custom.from} aria-invalid={!valid}
                    onChange={(event) => setCustom((value) => ({ ...value, from: event.target.value }))} />
                </Field>
                <Field data-invalid={!valid}>
                  <FieldLabel htmlFor="usage-to">Конец периода</FieldLabel>
                  <Input id="usage-to" type="date" value={custom.to} aria-invalid={!valid}
                    onChange={(event) => setCustom((value) => ({ ...value, to: event.target.value }))} />
                </Field>
                {!valid ? <FieldDescription role="alert" className="sm:col-span-2">
                  Выберите от 1 до 366 дней; начало не должно быть позже конца.
                </FieldDescription> : null}
              </FieldGroup>
            ) : null}
            <Field>
              <FieldLabel htmlFor="usage-user-search">Поиск в списке пользователей</FieldLabel>
              <Input id="usage-user-search" type="search" maxLength={64} value={search}
                placeholder="Имя, @username или Telegram ID"
                onChange={(event) => setSearch(event.target.value)} />
              <FieldDescription>Поиск меняет только список. Итоги и график сохраняют весь выбранный период.</FieldDescription>
            </Field>
          </FieldGroup>
        </CardContent>
      </Card>
      {error ? <ResourceError onRetry={() => setRetry((value) => value + 1)} /> : null}
      {report && data ? (
        <>
          <FieldDescription role="status">
            {loading || stale || error ? (
              <>{loading ? "Обновляю отчёт. " : ""}Показаны предыдущие данные. </>
            ) : null}
            Период показанных данных: {data.period.from} — {data.period.to} ({data.period.tz}).
            {" "}Показатель: {report.metric === "tokens" ? "токены" : "песочницы"}.
            {report.search ? <> Поиск в показанном списке: «{report.search}».</> : null}
          </FieldDescription>
          <UsageView data={data} metric={metric} displayedMetric={report.metric}
            onMetricChange={setMetric} userHref={href}
            loading={loading} navigationDisabled={loading || stale || error || !valid} search={report.search}
            onPageChange={(next) => setPagination({ key: pageKey, page: next })} />
        </>
      ) : loading ? <ResourceLoading /> : null}
    </section>
  );
}
