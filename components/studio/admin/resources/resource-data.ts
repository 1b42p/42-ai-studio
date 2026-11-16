import type { AdminSandboxesResponse, AdminUsageResponse } from "@/lib/admin/resource-types";

export interface UsageQuery {
  from: string;
  to: string;
  tz: string;
  userId?: string;
}

async function readReport<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { cache: "no-store", signal });
  if (!response.ok) throw new Error("admin_resource_request_failed");
  return response.json() as Promise<T>;
}

export function fetchAdminSandboxes(signal?: AbortSignal) {
  return readReport<AdminSandboxesResponse>("/api/admin/sandboxes", signal);
}

export function fetchAdminUsage(query: UsageQuery, signal?: AbortSignal) {
  return readReport<AdminUsageResponse>(
    `/api/admin/usage?${new URLSearchParams({ ...query })}`,
    signal,
  );
}

/** Calendar arithmetic in the selected zone, not elapsed 24-hour periods (DST). */
export function usagePeriod(days: number, zone: string, now: Date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  const part = (name: string) => parts.find((item) => item.type === name)!.value;
  const to = `${part("year")}-${part("month")}-${part("day")}`;
  const start = new Date(`${to}T12:00:00Z`);
  start.setUTCDate(start.getUTCDate() - days + 1);
  return { from: start.toISOString().slice(0, 10), to };
}
