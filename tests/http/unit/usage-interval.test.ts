import { expect, test } from "vitest";

import { sandboxIntervalEnd, sandboxTransition } from "../../../lib/usage/interval";

const start = new Date("2026-11-01T10:00:00Z");
const observed = new Date("2026-11-03T12:00:00Z");

test("приложение закрывает интервал в момент остановки, наблюдение — по последней активности", () => {
  expect(sandboxIntervalEnd({
    source: "app", runningSince: start, observedAt: observed,
    lastActiveAt: start, idleMinutes: 2,
  })).toEqual(observed);
  expect(sandboxIntervalEnd({
    source: "observed", runningSince: start, observedAt: observed,
    lastActiveAt: start, idleMinutes: 2,
  })).toEqual(new Date("2026-11-01T10:02:00Z"));
});

test("оценка ограничена началом и наблюдением и предпочитает активность Daytona", () => {
  for (const [activity, expected] of [
    ["2026-10-31T00:00:00Z", start],
    ["2026-11-05T00:00:00Z", observed],
    ["2026-11-01T11:00:00Z", new Date("2026-11-01T11:02:00Z")],
  ] as const) {
    expect(sandboxIntervalEnd({
      source: "observed", runningSince: start, observedAt: observed,
      lastActiveAt: start, lastActivityAt: new Date(activity), idleMinutes: 2,
    })).toEqual(expected);
  }
});

test("переходы открывают один интервал и закрывают его при любом выходе из работы", () => {
  for (const state of ["starting", "started", "stopped", "archived", "gone"] as const) {
    expect(sandboxTransition(state, "started", null)).toBe("open");
    expect(sandboxTransition(state, "started", start)).toBe("keep");
    for (const next of ["starting", "stopped", "archived", "gone"] as const) {
      expect(sandboxTransition(state, next, start)).toBe("close");
      expect(sandboxTransition(state, next, null)).toBe("keep");
    }
  }
});
