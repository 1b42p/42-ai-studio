/**
 * Использование ключа Daytona: разбор `OrganizationUsageOverview`, чтение
 * через API Daytona и память об ошибках. Сам ключ не пишется ни в журнал,
 * ни в базу: вызывающий код передаёт уже расшифрованный секрет.
 */
import { Daytona } from "@daytona/sdk";
import { eq } from "drizzle-orm";

import { loadConfig } from "../config";
import { getDb } from "../db/client";
import { sandboxes } from "../db/schema";
import { errorStatus } from "../sandbox/errors";
import { FakeStore } from "../sandbox/fake-store";

/** Коды, которые админка (#32) показывает вместо чисел. */
export const USAGE_ERRORS = ["unauthorized", "forbidden", "unavailable", "unexpected"] as const;
export type UsageError = (typeof USAGE_ERRORS)[number];

/** Занято и всего по одному измерению; единицы — vCPU или ГиБ. */
export interface UsageAmount {
  readonly used: number;
  readonly quota: number;
}

/** Пределы на одну песочницу из ответа Daytona; `null` — поле не задано. */
export interface UsageMaxPerSandbox {
  readonly cpu: number | null;
  readonly memoryGb: number | null;
  readonly diskGb: number | null;
}

/** Форма `daytona_keys.usage`; её читает админка (#32). */
export interface KeyUsage {
  readonly source: "daytona" | "error";
  /** Время последнего успешного чтения, ISO; ошибка его не сдвигает. */
  readonly fetchedAt: string | null;
  readonly organizationId: string | null;
  readonly region: string | null;
  readonly cpu: UsageAmount | null;
  readonly memoryGb: UsageAmount | null;
  readonly diskGb: UsageAmount | null;
  readonly maxPerSandbox: UsageMaxPerSandbox | null;
  readonly error: UsageError | null;
}

/** Числа одной записи `regionUsage` без привязки к ключу. */
export interface ParsedUsage {
  readonly region: string;
  readonly cpu: UsageAmount;
  readonly memoryGb: UsageAmount;
  readonly diskGb: UsageAmount;
  readonly maxPerSandbox: UsageMaxPerSandbox | null;
}

export type UsageParseResult =
  | { readonly kind: "ok"; readonly usage: ParsedUsage }
  /** Несколько записей `container`: нужен регион по умолчанию организации. */
  | { readonly kind: "ambiguous" }
  | { readonly kind: "invalid" };

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function amount(record: JsonRecord, usedKey: string, quotaKey: string): UsageAmount | null {
  const used = record[usedKey];
  const quota = record[quotaKey];
  if (!isNumber(used) || !isNumber(quota)) return null;
  return { used, quota };
}

function optionalNumber(record: JsonRecord, field: string): number | null | undefined {
  const value = record[field];
  if (value === null || value === undefined) return null;
  return isNumber(value) ? value : undefined;
}

/**
 * Разбирает ответ `OrganizationUsageOverview`. Из `regionUsage` берутся только
 * контейнерные песочницы не из служебного региона `earth`: несколько таких
 * записей разрешает регион по умолчанию организации. Единицы Daytona —
 * vCPU и ГиБ; числа переносятся без пересчёта.
 */
export function parseUsageOverview(
  payload: unknown,
  defaultRegionId: string | null,
): UsageParseResult {
  if (!isRecord(payload) || !Array.isArray(payload.regionUsage)) return { kind: "invalid" };
  const containers = payload.regionUsage.filter(
    (entry): entry is JsonRecord =>
      isRecord(entry) && entry.sandboxClass === "container" && entry.regionId !== "earth",
  );
  if (containers.length === 0) return { kind: "invalid" };

  let selected: JsonRecord | undefined;
  if (containers.length === 1) {
    selected = containers[0];
  } else {
    if (defaultRegionId === null) return { kind: "ambiguous" };
    const matches = containers.filter((entry) => entry.regionId === defaultRegionId);
    if (matches.length !== 1) return { kind: "invalid" };
    selected = matches[0];
  }

  const region = selected.regionId;
  if (typeof region !== "string" || region.length === 0) return { kind: "invalid" };
  const cpu = amount(selected, "currentCpuUsage", "totalCpuQuota");
  const memoryGb = amount(selected, "currentMemoryUsage", "totalMemoryQuota");
  const diskGb = amount(selected, "currentDiskUsage", "totalDiskQuota");
  if (cpu === null || memoryGb === null || diskGb === null) return { kind: "invalid" };

  const maxCpu = optionalNumber(selected, "maxCpuPerSandbox");
  const maxMemory = optionalNumber(selected, "maxMemoryPerSandbox");
  const maxDisk = optionalNumber(selected, "maxDiskPerSandbox");
  if (maxCpu === undefined || maxMemory === undefined || maxDisk === undefined) {
    return { kind: "invalid" };
  }
  const maxPerSandbox =
    maxCpu === null && maxMemory === null && maxDisk === null
      ? null
      : { cpu: maxCpu, memoryGb: maxMemory, diskGb: maxDisk };

  return { kind: "ok", usage: { region, cpu, memoryGb, diskGb, maxPerSandbox } };
}

function readStoredAmount(value: unknown): UsageAmount | null {
  if (!isRecord(value) || !isNumber(value.used) || !isNumber(value.quota)) return null;
  return { used: value.used, quota: value.quota };
}

function readStoredMax(value: unknown): UsageMaxPerSandbox | null {
  if (!isRecord(value)) return null;
  const read = (field: unknown) => (field === null ? null : isNumber(field) ? field : null);
  const max = { cpu: read(value.cpu), memoryGb: read(value.memoryGb), diskGb: read(value.diskGb) };
  return max.cpu === null && max.memoryGb === null && max.diskGb === null ? null : max;
}

/** Терпимо читает `daytona_keys.usage`; неизвестная форма — как отсутствие. */
export function storedUsage(value: unknown): KeyUsage | null {
  if (!isRecord(value)) return null;
  const error = USAGE_ERRORS.find((code) => code === value.error) ?? null;
  return {
    source: value.source === "daytona" ? "daytona" : "error",
    fetchedAt: typeof value.fetchedAt === "string" ? value.fetchedAt : null,
    organizationId:
      typeof value.organizationId === "string" && value.organizationId.length > 0
        ? value.organizationId
        : null,
    region: typeof value.region === "string" ? value.region : null,
    cpu: readStoredAmount(value.cpu),
    memoryGb: readStoredAmount(value.memoryGb),
    diskGb: readStoredAmount(value.diskGb),
    maxPerSandbox: readStoredMax(value.maxPerSandbox),
    error,
  };
}

/** Прежние числа остаются, меняются только `source` и `error`. */
export function failedUsage(
  previous: KeyUsage | null,
  error: UsageError,
  organizationId: string | null,
): KeyUsage {
  return {
    source: "error",
    fetchedAt: previous?.fetchedAt ?? null,
    organizationId: organizationId ?? previous?.organizationId ?? null,
    region: previous?.region ?? null,
    cpu: previous?.cpu ?? null,
    memoryGb: previous?.memoryGb ?? null,
    diskGb: previous?.diskGb ?? null,
    maxPerSandbox: previous?.maxPerSandbox ?? null,
    error,
  };
}

/** Ошибка HTTP-ответа Daytona; текст ответа никуда не передаётся. */
export class UsageHttpError extends Error {
  constructor(readonly status: number) {
    super(`Daytona usage request failed with ${status}`);
    this.name = "UsageHttpError";
  }
}

/** Ответ пришёл, но не той формы. */
export class UsageShapeError extends Error {
  constructor() {
    super("Daytona usage response has an unexpected shape");
    this.name = "UsageShapeError";
  }
}

/** Сеть, таймаут или DNS: конечная точка недоступна. */
export class UsageNetworkError extends Error {
  constructor() {
    super("Daytona usage endpoint is unavailable");
    this.name = "UsageNetworkError";
  }
}

export function usageErrorOf(error: unknown): UsageError {
  if (error instanceof UsageShapeError) return "unexpected";
  if (error instanceof UsageHttpError) return statusError(error.status);
  // Фиктивный слой и SDK бросают обычные ошибки со статусом в поле.
  const status = errorStatus(error);
  if (status !== undefined) return statusError(status);
  return "unavailable";
}

function statusError(status: number): UsageError {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 429 || status >= 500) return "unavailable";
  return "unexpected";
}

/** Источник данных использования: настоящий Daytona или фиктивный слой. */
interface UsageSource {
  /** `organizationId` текущего ключа; `undefined`, если поле не пришло. */
  keyOrganization(): Promise<string | undefined>;
  /** Все организации пользователя-владельца ключа. */
  organizations(): Promise<string[]>;
  organizationUsage(organizationId: string): Promise<unknown>;
  /** Регион по умолчанию организации; `undefined`, если поле не пришло. */
  organizationDefaultRegion(organizationId: string): Promise<string | undefined>;
  /** `organizationId` конкретной песочницы; `undefined`, если её нет. */
  sandboxOrganization(sandboxId: string): Promise<string | undefined>;
}

function optionalString(record: unknown, field: string): string | undefined {
  if (!isRecord(record)) return undefined;
  const value = record[field];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function httpSource(secret: string): UsageSource {
  const config = loadConfig();
  const base = config.daytonaApiUrl.replace(/\/+$/, "");

  async function request(path: string): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(`${base}${path}`, {
        headers: { authorization: `Bearer ${secret}`, accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
        cache: "no-store",
      });
    } catch {
      throw new UsageNetworkError();
    }
    if (!response.ok) throw new UsageHttpError(response.status);
    try {
      return await response.json();
    } catch {
      throw new UsageShapeError();
    }
  }

  return {
    async keyOrganization() {
      return optionalString(await request("/api-keys/current"), "organizationId");
    },
    async organizations() {
      const body = await request("/organizations");
      if (!Array.isArray(body)) throw new UsageShapeError();
      return body
        .map((entry) => optionalString(entry, "id"))
        .filter((id): id is string => id !== undefined);
    },
    organizationUsage: (organizationId) =>
      request(`/organizations/${encodeURIComponent(organizationId)}/usage`),
    async organizationDefaultRegion(organizationId) {
      return optionalString(await request(`/organizations/${encodeURIComponent(organizationId)}`), "defaultRegionId");
    },
    async sandboxOrganization(sandboxId) {
      try {
        const sandbox = await new Daytona({ apiKey: secret, apiUrl: config.daytonaApiUrl }).get(sandboxId);
        return typeof sandbox.organizationId === "string" && sandbox.organizationId.length > 0
          ? sandbox.organizationId
          : undefined;
      } catch (error) {
        const status = errorStatus(error);
        if (status === 404) return undefined;
        if (status === undefined) throw new UsageNetworkError();
        throw new UsageHttpError(status);
      }
    },
  };
}

function fakeSource(secret: string): UsageSource {
  const directory = loadConfig().fakeSandboxDir;
  if (directory === undefined) throw new Error("FAKE_SANDBOX_DIR is required in test mode");
  const store = new FakeStore(directory);
  return {
    keyOrganization: () => store.keyOrganization(secret),
    organizations: async () => [await store.keyOrganization(secret)],
    organizationUsage: async (organizationId) => store.organizationUsage(secret, organizationId),
    organizationDefaultRegion: async () => "us-east-1",
    sandboxOrganization: (sandboxId) => store.sandboxOrganization(sandboxId),
  };
}

async function resolveOrganization(
  keyId: string,
  source: UsageSource,
  previous: KeyUsage | null,
): Promise<string | undefined> {
  // Результат прошлого удачного разрешения запоминается в `usage`.
  if (previous?.organizationId) return previous.organizationId;

  const current = await source.keyOrganization();
  if (current !== undefined) return current;

  const organizations = await source.organizations();
  if (organizations.length === 1) return organizations[0];

  // `GET /organizations` перечисляет организации владельца ключа, а не самого
  // ключа: при неоднозначности помогает любая его песочница.
  const [row] = await getDb()
    .select({ daytonaSandboxId: sandboxes.daytonaSandboxId })
    .from(sandboxes)
    .where(eq(sandboxes.daytonaKeyId, keyId))
    .limit(1);
  if (row !== undefined && row.daytonaSandboxId.length > 0) {
    const organizationId = await source.sandboxOrganization(row.daytonaSandboxId);
    if (organizationId !== undefined) return organizationId;
  }
  return undefined;
}

/**
 * Читает использование ключа. При любой ошибке прежние числа сохраняются,
 * заполняется только `error`; исключение не выходит наружу.
 */
export async function fetchUsage(
  keyId: string,
  secret: string,
  previous: KeyUsage | null,
): Promise<KeyUsage> {
  const source = loadConfig().appTestMode ? fakeSource(secret) : httpSource(secret);
  let organizationId: string | null = previous?.organizationId ?? null;
  try {
    organizationId = (await resolveOrganization(keyId, source, previous)) ?? null;
    if (organizationId === null) return failedUsage(previous, "unexpected", null);

    const payload = await source.organizationUsage(organizationId);
    let parsed = parseUsageOverview(payload, null);
    if (parsed.kind === "ambiguous") {
      const region = (await source.organizationDefaultRegion(organizationId)) ?? null;
      parsed = parseUsageOverview(payload, region);
    }
    if (parsed.kind !== "ok") return failedUsage(previous, "unexpected", organizationId);
    return {
      source: "daytona",
      fetchedAt: new Date().toISOString(),
      organizationId,
      error: null,
      ...parsed.usage,
    };
  } catch (error) {
    return failedUsage(previous, usageErrorOf(error), organizationId);
  }
}
