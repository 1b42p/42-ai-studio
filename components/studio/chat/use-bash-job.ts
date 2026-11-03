"use client";

/**
 * Опрос задания `bash` (#11). Один общий опрос на пару «сессия, задание»:
 * несколько карточек одного задания на странице не дублируют запросы.
 * Интервал растёт от 2 до 5 и 10 секунд по времени показа карточки, ошибки
 * повторяются с удвоением до 30 секунд, скрытая вкладка опрос приостанавливает.
 */
import { useEffect, useState } from "react";

import { JOB_ID_PATTERN, type BashJobResponse } from "@/lib/sandbox/job-types";

export interface BashJobPoll {
  readonly kind: "idle" | "pending" | "data" | "unauthorized" | "not_found";
  /** Последний успешный ответ; при сетевой ошибке остаётся прежним. */
  readonly job: BashJobResponse | null;
  /** Ошибок подряд; после пятой карточка пишет «Нет связи, повторяем…». */
  readonly failures: number;
}

const IDLE: BashJobPoll = { kind: "idle", job: null, failures: 0 };
const FIRST_INTERVAL_MS = 2_000;
const SLOW_INTERVAL_MS = 5_000;
const SLOWEST_INTERVAL_MS = 10_000;
const MINUTE_MS = 60_000;
const TEN_MINUTES_MS = 10 * 60_000;
const MAX_RETRY_MS = 30_000;

interface Entry {
  state: BashJobPoll;
  readonly listeners: Set<(state: BashJobPoll) => void>;
  timer: ReturnType<typeof setTimeout> | null;
  failures: number;
  shownAt: number;
  inflight: boolean;
  stopped: boolean;
}

const entries = new Map<string, Entry>();
let visibilityBound = false;

function visible(): boolean {
  return typeof document === "undefined" || document.visibilityState !== "hidden";
}

function emit(entry: Entry): void {
  for (const listener of entry.listeners) listener(entry.state);
}

function update(entry: Entry, state: BashJobPoll): void {
  entry.state = state;
  emit(entry);
}

function clearTimer(entry: Entry): void {
  if (entry.timer !== null) {
    clearTimeout(entry.timer);
    entry.timer = null;
  }
}

function baseInterval(entry: Entry): number {
  const elapsed = Date.now() - entry.shownAt;
  if (elapsed >= TEN_MINUTES_MS) return SLOWEST_INTERVAL_MS;
  if (elapsed >= MINUTE_MS) return SLOW_INTERVAL_MS;
  return FIRST_INTERVAL_MS;
}

function retryInterval(failures: number): number {
  return Math.min(MAX_RETRY_MS, FIRST_INTERVAL_MS * 2 ** Math.max(0, failures - 1));
}

function stop(entry: Entry): void {
  entry.stopped = true;
  clearTimer(entry);
}

function schedule(key: string, entry: Entry, delay: number): void {
  clearTimer(entry);
  if (entry.stopped || entry.listeners.size === 0 || !visible()) return;
  entry.timer = setTimeout(() => {
    entry.timer = null;
    void poll(key, entry);
  }, delay);
}

function retry(key: string, entry: Entry): void {
  entry.failures += 1;
  update(entry, {
    kind: entry.state.job === null ? "pending" : entry.state.kind,
    job: entry.state.job,
    failures: entry.failures,
  });
  schedule(key, entry, retryInterval(entry.failures));
}

async function poll(key: string, entry: Entry): Promise<void> {
  if (
    entry.stopped ||
    entry.inflight ||
    entry.listeners.size === 0 ||
    !visible()
  ) {
    return;
  }
  entry.inflight = true;
  const [appSessionId, jobId] = key.split("\u0000") as [string, string];
  try {
    const response = await fetch(
      `/api/sessions/${appSessionId}/jobs/${jobId}`,
      { cache: "no-store", headers: { accept: "application/json" } },
    );
    if (entries.get(key) !== entry) return;

    if (response.status === 401) {
      update(entry, { kind: "unauthorized", job: entry.state.job, failures: 0 });
      stop(entry);
      return;
    }
    if (response.status === 404) {
      update(entry, { kind: "not_found", job: entry.state.job, failures: 0 });
      stop(entry);
      return;
    }
    if (!response.ok) {
      retry(key, entry);
      return;
    }

    const job = (await response.json()) as BashJobResponse;
    entry.failures = 0;
    update(entry, { kind: "data", job, failures: 0 });
    if (job.status !== "running") {
      stop(entry);
      return;
    }
    schedule(key, entry, baseInterval(entry));
  } catch {
    if (entries.get(key) === entry) retry(key, entry);
  } finally {
    entry.inflight = false;
  }
}

function bindVisibility(): void {
  if (visibilityBound || typeof document === "undefined") return;
  visibilityBound = true;
  document.addEventListener("visibilitychange", () => {
    if (!visible()) {
      for (const entry of entries.values()) clearTimer(entry);
      return;
    }
    for (const [key, entry] of entries) {
      if (entry.stopped || entry.listeners.size === 0) continue;
      void poll(key, entry);
    }
  });
}

function subscribe(key: string, listener: (state: BashJobPoll) => void): () => void {
  let entry = entries.get(key);
  const created = entry === undefined;
  if (entry === undefined) {
    entry = {
      state: { kind: "pending", job: null, failures: 0 },
      listeners: new Set(),
      timer: null,
      failures: 0,
      shownAt: Date.now(),
      inflight: false,
      stopped: false,
    };
    entries.set(key, entry);
    bindVisibility();
  }
  entry.listeners.add(listener);
  listener(entry.state);
  if (created) void poll(key, entry);

  return () => {
    entry.listeners.delete(listener);
    if (entry.listeners.size > 0) return;
    stop(entry);
    entries.delete(key);
  };
}

/** Состояние задания для карточки; без сессии и задания опроса нет. */
export function useBashJob(
  appSessionId: string | null | undefined,
  jobId: string | null,
): BashJobPoll {
  const key = appSessionId && jobId !== null && JOB_ID_PATTERN.test(jobId)
    ? `${appSessionId}\u0000${jobId}`
    : null;
  const [state, setState] = useState<BashJobPoll>(IDLE);

  useEffect(() => {
    if (key === null) {
      setState(IDLE);
      return;
    }
    return subscribe(key, setState);
  }, [key]);

  return key === null ? IDLE : state;
}
