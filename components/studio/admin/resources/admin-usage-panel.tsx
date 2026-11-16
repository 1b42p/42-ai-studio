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

const PERIODS = [
  { value: "1", label: "Сегодня" }, { value: "7", label: "7 дней" },
  { value: "30", label: "30 дней" }, { value: "90", label: "90 дней" },
  { value: "custom", label: "Свой период" },
] as const;

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
  const [data, setData] = useState(initialData ?? null);
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
    void requestRef.current({ from, to, tz: zone, ...(userId ? { userId } : {}) }, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setData(result);
      }).catch(() => {
        if (!controller.signal.aborted) setError(true);
      }).finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [from, to, userId, valid, zone, retry]);

  const href = (id?: string) => {
    const query = new URLSearchParams({ from, to });
    if (id) query.set("userId", id);
    return `/admin/usage?${query}`;
  };

  return (
    <section aria-label="Расход" className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-medium">Расход</h2>
        <p className="text-sm text-muted-foreground">
          Время песочниц считается, пока песочница запущена; остановку самой Daytona по бездействию учитывает приблизительно. Токены — по данным провайдера модели.
        </p>
      </div>
      {initialUser ? <UsageUserFilter user={initialUser} onReset={onResetFilter} resetHref={href()} /> : null}
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
              <ToggleGroupItem key={item.value} value={item.value}>{item.label}</ToggleGroupItem>
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
      </FieldGroup>
      {loading ? <ResourceLoading /> : error ? <ResourceError onRetry={() => setRetry((value) => value + 1)} />
        : data && valid ? <UsageView data={data} metric={metric} onMetricChange={setMetric} userHref={href} /> : null}
    </section>
  );
}
