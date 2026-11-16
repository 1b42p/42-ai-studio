"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { AdminSandboxesResponse } from "@/lib/admin/resource-types";
import { fetchAdminSandboxes } from "./resource-data";
import { ResourceError, ResourceLoading, useBrowserTimeZone } from "./shared";
import { SandboxesView } from "./sandboxes-view";

export function AdminSandboxesPanel({ initialData, request = fetchAdminSandboxes, timeZone }: {
  initialData?: AdminSandboxesResponse;
  request?: (signal?: AbortSignal) => Promise<AdminSandboxesResponse>;
  timeZone?: string;
}) {
  const [data, setData] = useState(initialData ?? null);
  const [loading, setLoading] = useState(!initialData);
  const [error, setError] = useState(false);
  const zone = useBrowserTimeZone(timeZone);
  const requestRef = useRef(request);
  requestRef.current = request;
  const active = useRef<AbortController | null>(null);

  const load = useCallback(() => {
    if (active.current) return;
    const controller = new AbortController();
    active.current = controller;
    setLoading(true);
    setError(false);
    void requestRef.current(controller.signal).then((result) => {
      if (!controller.signal.aborted) setData(result);
    }).catch(() => {
      if (!controller.signal.aborted) setError(true);
    }).finally(() => {
      if (!controller.signal.aborted) {
        active.current = null;
        setLoading(false);
      }
    });
  }, []);

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined;
    const sync = () => {
      clearInterval(timer);
      if (document.visibilityState === "hidden") return;
      timer = setInterval(load, 10_000);
    };
    if (!initialData && document.visibilityState !== "hidden") load();
    const visible = () => {
      sync();
      if (document.visibilityState !== "hidden") load();
    };
    sync();
    document.addEventListener("visibilitychange", visible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", visible);
      active.current?.abort();
      active.current = null;
    };
  }, [initialData, load]);

  return (
    <section aria-label="Песочницы" className="flex min-w-0 flex-col gap-4">
      <h2 className="text-lg font-medium">Песочницы</h2>
      {error ? <ResourceError onRetry={load} /> : null}
      {data ? <SandboxesView data={data} onRefresh={load} refreshing={loading} timeZone={zone} />
        : !error ? <ResourceLoading /> : null}
    </section>
  );
}
