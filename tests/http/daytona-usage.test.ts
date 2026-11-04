/** Чистый разбор `OrganizationUsageOverview` из ответа Daytona (#23). */
import { describe, expect, test } from "vitest";

import {
  failedUsage,
  parseUsageOverview,
  storedUsage,
  usageErrorOf,
  UsageHttpError,
  UsageShapeError,
  USAGE_ERRORS,
} from "../../lib/daytona/usage";

function entry(overrides: Record<string, unknown> = {}) {
  return {
    regionId: "us-east-1",
    sandboxClass: "container",
    totalCpuQuota: 10,
    currentCpuUsage: 2,
    totalMemoryQuota: 20,
    currentMemoryUsage: 4,
    totalDiskQuota: 30,
    currentDiskUsage: 8,
    maxCpuPerSandbox: 4,
    maxMemoryPerSandbox: 8,
    maxDiskPerSandbox: 10,
    maxCpuPerGpu: null,
    maxMemoryPerGpu: null,
    maxDiskPerGpu: null,
    maxDiskPerNonEphemeralSandbox: null,
    totalGpuQuota: 0,
    currentGpuUsage: 0,
    allowedGpuTypes: [],
    ...overrides,
  };
}

function overview(entries: unknown[]) {
  return {
    regionUsage: entries,
    totalSnapshotQuota: 0,
    currentSnapshotUsage: 0,
    totalVolumeQuota: 0,
    currentVolumeUsage: 0,
  };
}

describe("разбор использования Daytona", () => {
  test("одна запись container переходит в форму usage без пересчёта единиц", () => {
    const result = parseUsageOverview(overview([entry()]), null);
    expect(result).toEqual({
      kind: "ok",
      usage: {
        region: "us-east-1",
        cpu: { used: 2, quota: 10 },
        memoryGb: { used: 4, quota: 20 },
        diskGb: { used: 8, quota: 30 },
        maxPerSandbox: { cpu: 4, memoryGb: 8, diskGb: 10 },
      },
    });
  });

  test("container и linux-vm в разных регионах: берётся только container", () => {
    const result = parseUsageOverview(
      overview([
        entry({ regionId: "eu-central-1", sandboxClass: "linux-vm", currentCpuUsage: 9 }),
        entry({ regionId: "us-east-1", currentCpuUsage: 1 }),
      ]),
      null,
    );
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.usage.region).toBe("us-east-1");
    expect(result.usage.cpu).toEqual({ used: 1, quota: 10 });
  });

  test("служебный регион earth пропускается, даже если он container", () => {
    const result = parseUsageOverview(
      overview([
        entry({ regionId: "earth", currentCpuUsage: 7 }),
        entry({ regionId: "us-east-1", currentCpuUsage: 1 }),
      ]),
      null,
    );
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.usage.cpu.used).toBe(1);
  });

  test("несколько container без региона по умолчанию неоднозначны, с регионом — выбирается он", () => {
    const entries = [entry({ regionId: "eu-central-1" }), entry({ regionId: "us-east-1" })];
    expect(parseUsageOverview(overview(entries), null).kind).toBe("ambiguous");

    const result = parseUsageOverview(overview(entries), "eu-central-1");
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.usage.region).toBe("eu-central-1");
  });

  test("неизвестный регион по умолчанию не даёт выбрать запись", () => {
    const entries = [entry({ regionId: "eu-central-1" }), entry({ regionId: "us-east-1" })];
    expect(parseUsageOverview(overview(entries), "ap-south-1").kind).toBe("invalid");
  });

  test.each([
    ["поле sandboxClass отсутствует", overview([entry({ sandboxClass: undefined })])],
    ["нет regionUsage", { totalSnapshotQuota: 0 }],
    ["regionUsage не массив", { regionUsage: "нет" }],
    ["нет числа квоты", overview([entry({ totalCpuQuota: undefined })])],
    ["отрицательное число", overview([entry({ currentCpuUsage: -1 })])],
    ["не число", overview([entry({ currentDiskUsage: "8" })])],
    ["некорректный предел на песочницу", overview([entry({ maxCpuPerSandbox: "4" })])],
  ])("неполный ответ даёт unexpected: %s", (_name, payload) => {
    expect(parseUsageOverview(payload, null).kind).toBe("invalid");
  });

  test("нулевые пределы на песочницу дают maxPerSandbox: null", () => {
    const result = parseUsageOverview(
      overview([entry({ maxCpuPerSandbox: null, maxMemoryPerSandbox: null, maxDiskPerSandbox: null })]),
      null,
    );
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.usage.maxPerSandbox).toBeNull();
  });
});

describe("память о прошлом использовании", () => {
  test("ошибка сохраняет прежние числа и заполняет error", () => {
    const previous = storedUsage({
      source: "daytona",
      fetchedAt: "2026-11-04T10:00:00.000Z",
      organizationId: "org-1",
      region: "us-east-1",
      cpu: { used: 2, quota: 10 },
      memoryGb: { used: 4, quota: 20 },
      diskGb: { used: 8, quota: 30 },
      maxPerSandbox: null,
      error: null,
    });
    expect(previous).not.toBeNull();
    const failed = failedUsage(previous, "forbidden", "org-1");
    expect(failed).toMatchObject({
      source: "error",
      error: "forbidden",
      organizationId: "org-1",
      fetchedAt: "2026-11-04T10:00:00.000Z",
      cpu: { used: 2, quota: 10 },
    });
  });

  test("неизвестная форма usage читается как отсутствие", () => {
    expect(storedUsage(null)).toBeNull();
    expect(storedUsage("строка")).toBeNull();
    expect(storedUsage({ error: "что-то" })?.error).toBeNull();
  });

  test("коды ошибок по статусу ответа", () => {
    expect(usageErrorOf(new UsageHttpError(401))).toBe("unauthorized");
    expect(usageErrorOf(new UsageHttpError(403))).toBe("forbidden");
    expect(usageErrorOf(new UsageHttpError(429))).toBe("unavailable");
    expect(usageErrorOf(new UsageHttpError(503))).toBe("unavailable");
    expect(usageErrorOf(new UsageShapeError())).toBe("unexpected");
    expect(usageErrorOf(new TypeError("сеть"))).toBe("unavailable");
    expect(USAGE_ERRORS).toContain("unexpected");
  });
});
