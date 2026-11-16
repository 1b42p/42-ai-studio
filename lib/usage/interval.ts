import type { SandboxState } from "../db/schema";

export type TransitionSource = "app" | "observed";

export function sandboxTransition(
  _previous: SandboxState,
  next: SandboxState,
  runningSince: Date | null,
): "open" | "close" | "keep" {
  if (next === "started") return runningSince === null ? "open" : "keep";
  // Сохранившийся после отказа учёта интервал также нужно дозаписать.
  return runningSince === null ? "keep" : "close";
}

export function sandboxIntervalEnd(options: {
  source: TransitionSource;
  runningSince: Date;
  observedAt: Date;
  lastActiveAt: Date;
  lastActivityAt?: Date | null;
  idleMinutes: number;
}): Date {
  const observation = options.observedAt.getTime();
  const estimate = options.source === "app"
    ? observation
    : (options.lastActivityAt ?? options.lastActiveAt).getTime() + options.idleMinutes * 60_000;
  return new Date(Math.max(options.runningSince.getTime(), Math.min(observation, estimate)));
}
