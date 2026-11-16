"use client";

import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import {
  ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import type { AdminUsageResponse } from "@/lib/admin/resource-types";
import { formatHours, formatTokens } from "./shared";

const config = {
  sandboxSeconds: { label: "Песочницы, ч", color: "var(--chart-1)" },
  inputTokens: { label: "Входные", color: "var(--chart-1)" },
  outputTokens: { label: "Выходные", color: "var(--chart-2)" },
} satisfies ChartConfig;

function formatDay(date: string) {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: "UTC", day: "numeric", month: "short",
  }).format(new Date(`${date}T12:00:00Z`));
}

export function UsageChart({ days, metric }: {
  days: AdminUsageResponse["byDay"];
  metric: "sandboxes" | "tokens";
}) {
  const keys = metric === "sandboxes" ? ["sandboxSeconds"] : ["inputTokens", "outputTokens"];
  return (
    <ChartContainer config={config} className="h-64 min-h-64 w-full min-w-0 aspect-auto"
      aria-label={metric === "sandboxes" ? "Время песочниц по дням" : "Токены по дням"}>
      <BarChart accessibilityLayer data={days} margin={{ left: 0, right: 0 }}>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="date" tickFormatter={formatDay} tickLine={false} axisLine={false} minTickGap={28} />
        <YAxis width={48} tickLine={false} axisLine={false}
          tickFormatter={(value: number) => metric === "sandboxes" ? formatHours(value) : formatTokens(value)} />
        <ChartTooltip isAnimationActive={false} content={<ChartTooltipContent
          labelFormatter={(value) => formatDay(String(value))}
          formatter={(value, name) => `${config[name as keyof typeof config]?.label ?? name}: ${
            metric === "sandboxes" ? formatHours(Number(value)) : formatTokens(Number(value))
          }`}
        />} />
        <ChartLegend content={<ChartLegendContent />} />
        {keys.map((key) => (
          <Bar key={key} dataKey={key} fill={`var(--color-${key})`} radius={3}
            isAnimationActive={false} />
        ))}
      </BarChart>
    </ChartContainer>
  );
}
