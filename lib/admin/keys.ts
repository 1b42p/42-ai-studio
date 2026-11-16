/**
 * Ключи Daytona для оператора. Ответ собирается белым списком: секрет и
 * шифротекст не попадают ни в JSON, ни в журнал.
 */
import { createHash, timingSafeEqual } from "node:crypto";

import { asc, eq } from "drizzle-orm";

import {
  DELETED_KEY_MARKER,
  deleteKey,
  disableKey,
  enableKey,
  freeCapacity,
  refreshUsage,
  reservedNeed,
  type KeyNeed,
} from "@/agent/lib/daytona-key-pool";
import { loadConfig } from "@/lib/config";
import { getDb, getSqlClient } from "@/lib/db/client";
import {
  daytonaKeys,
  pendingSandboxDeletions,
  sandboxes,
  type DaytonaKey,
  type SandboxLaunch,
} from "@/lib/db/schema";
import { probeApiKey, storedUsage } from "@/lib/daytona/usage";
import { DAYTONA_KEY_PURPOSE, decryptSecret, encryptSecret } from "@/lib/secrets";
import {
  quotaShareWarning,
  labelKey,
  isValidApiKey,
  isValidKeyLabel,
  KEY_DELETED_MESSAGE,
  KEY_LABEL_CONFLICT_MESSAGE,
  KEY_REJECTED_MESSAGE,
  KEY_SECRET_CONFLICT_MESSAGE,
  KEY_UNAVAILABLE_MESSAGE,
  KEY_VALIDATION_MESSAGE,
  type AdminKeyDefaults,
  type AdminKeySandboxes,
  type AdminKeysPage,
  type AdminKeyView,
} from "./key-view";

export type {
  AdminKeyDefaults,
  AdminKeySandboxes,
  AdminKeysPage,
  AdminKeyView,
} from "./key-view";

const ZERO: KeyNeed = { cpu: 0, memoryGb: 0, diskGb: 0 };
const REFRESH_MIN_MS = 5_000;
const DELETE_BUDGET_MS = 120_000;
const DELETE_CONCURRENCY = 5;
const ADD_LOCK_CLASS = 5;

export type AdminKeyError = {
  readonly status: 400 | 404 | 409 | 502;
  readonly code: "invalid_request" | "not_found" | "conflict" | "upstream_error";
  readonly message: string;
};

export type AdminKeyResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: AdminKeyError };

function fail(
  status: AdminKeyError["status"],
  code: AdminKeyError["code"],
  message: string,
): AdminKeyResult<never> {
  return { ok: false, error: { status, code, message } };
}

function iso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function sameSecret(left: string, right: string): boolean {
  const a = digest(left);
  const b = digest(right);
  return timingSafeEqual(a, b);
}

function defaults(): AdminKeyDefaults {
  const config = loadConfig();
  return { cpu: config.sandboxCpu, memoryGb: config.sandboxMemoryGb, diskGb: config.sandboxDiskGb };
}

function sandboxSize(): KeyNeed {
  return defaults();
}

interface SandboxTally {
  running: number;
  stopped: number;
  archived: number;
}

function emptyTally(): SandboxTally {
  return { running: 0, stopped: 0, archived: 0 };
}

async function sandboxTallies(): Promise<Map<string, SandboxTally>> {
  const rows = await getDb()
    .select({ keyId: sandboxes.daytonaKeyId, state: sandboxes.state })
    .from(sandboxes);
  const totals = new Map<string, SandboxTally>();
  for (const row of rows) {
    const tally = totals.get(row.keyId) ?? emptyTally();
    if (row.state === "starting" || row.state === "started") tally.running += 1;
    else if (row.state === "stopped") tally.stopped += 1;
    else if (row.state === "archived") tally.archived += 1;
    totals.set(row.keyId, tally);
  }
  return totals;
}

async function reservedByPool(keys: readonly DaytonaKey[]): Promise<Map<string, KeyNeed>> {
  const organization = new Map(
    keys.map((key) => [key.id, storedUsage(key.usage)?.organizationId ?? `key:${key.id}`]),
  );
  const fresh = await getSqlClient()`
    select daytona_key_id as "keyId", starting_kind as "kind"
    from sandboxes
    where state = 'starting' and starting_since > now() - interval '5 minutes'`;
  const size = sandboxSize();
  const reserved = new Map<string, KeyNeed>();
  for (const row of fresh as unknown as Array<{ keyId: string; kind: SandboxLaunch | null }>) {
    const pool = organization.get(row.keyId) ?? `key:${row.keyId}`;
    const current = reserved.get(pool) ?? ZERO;
    const need = reservedNeed(row.kind, size);
    reserved.set(pool, {
      cpu: current.cpu + need.cpu,
      memoryGb: current.memoryGb + need.memoryGb,
      diskGb: current.diskGb + need.diskGb,
    });
  }
  return reserved;
}

async function remainingSandboxes(keyId: string): Promise<number> {
  const db = getDb();
  const rows = await db.select().from(sandboxes).where(eq(sandboxes.daytonaKeyId, keyId));
  const pending = await db
    .select()
    .from(pendingSandboxDeletions)
    .where(eq(pendingSandboxDeletions.daytonaKeyId, keyId));
  let remaining = rows.filter((row) => row.state !== "gone" && row.daytonaSandboxId === "").length;
  const counted = new Set<string>();
  for (const row of rows) {
    if (row.state === "gone" || row.daytonaSandboxId === "") continue;
    if (counted.has(row.daytonaSandboxId)) continue;
    counted.add(row.daytonaSandboxId);
    remaining += 1;
  }
  for (const entry of pending) {
    if (counted.has(entry.daytonaSandboxId)) continue;
    counted.add(entry.daytonaSandboxId);
    remaining += 1;
  }
  return remaining;
}

function warningFor(key: DaytonaKey, keys: readonly DaytonaKey[]): string | null {
  const organizationId = storedUsage(key.usage)?.organizationId;
  if (organizationId == null || key.deletedAt !== null) return null;
  const other = keys.find(
    (candidate) =>
      candidate.id !== key.id &&
      candidate.deletedAt === null &&
      storedUsage(candidate.usage)?.organizationId === organizationId,
  );
  return other === undefined ? null : quotaShareWarning(other.label);
}

async function toView(
  key: DaytonaKey,
  keys: readonly DaytonaKey[],
  order: number | null,
  tallies: Map<string, SandboxTally>,
  reserved: Map<string, KeyNeed>,
): Promise<AdminKeyView> {
  const usage = storedUsage(key.usage);
  const pool = usage?.organizationId ?? `key:${key.id}`;
  const ciphertextKept = key.deletedAt !== null && key.apiKeyEncrypted !== DELETED_KEY_MARKER;
  return {
    id: key.id,
    label: key.label,
    enabled: key.enabled,
    deletedAt: iso(key.deletedAt),
    createdAt: key.createdAt.toISOString(),
    order,
    usage,
    usageCheckedAt: iso(key.usageCheckedAt),
    exhaustedUntil: iso(key.exhaustedUntil),
    remainingSandboxes: ciphertextKept ? await remainingSandboxes(key.id) : null,
    fits: freeCapacity(usage, reserved.get(pool) ?? ZERO, sandboxSize()),
    sandboxes: tallies.get(key.id) ?? emptyTally(),
    warning: warningFor(key, keys),
  };
}

async function present(key: DaytonaKey): Promise<AdminKeyView> {
  const keys = await getDb().select().from(daytonaKeys).orderBy(asc(daytonaKeys.createdAt), asc(daytonaKeys.id));
  const active = keys.filter((row) => row.deletedAt === null);
  const order = key.deletedAt === null ? active.findIndex((row) => row.id === key.id) + 1 : null;
  const [tallies, reserved] = await Promise.all([sandboxTallies(), reservedByPool(keys)]);
  return toView(key, keys, order === 0 ? null : order, tallies, reserved);
}

export function parseDeletedFilter(value: string | null): AdminKeyResult<boolean> {
  if (value === null || value === "0") return { ok: true, value: false };
  if (value === "1") return { ok: true, value: true };
  return fail(400, "invalid_request", "Параметр deleted должен быть 0 или 1.");
}

export async function listAdminKeys(deleted: boolean): Promise<AdminKeysPage> {
  const db = getDb();
  const keys = await db.select().from(daytonaKeys).orderBy(asc(daytonaKeys.createdAt), asc(daytonaKeys.id));
  const active = keys.filter((row) => row.deletedAt === null);
  const selected = deleted ? keys.filter((row) => row.deletedAt !== null) : active;
  const [tallies, reserved] = await Promise.all([sandboxTallies(), reservedByPool(keys)]);
  const items: AdminKeyView[] = [];
  for (const key of selected) {
    const order = key.deletedAt === null ? active.findIndex((row) => row.id === key.id) + 1 : null;
    items.push(await toView(key, keys, order, tallies, reserved));
  }
  return { items, defaults: defaults() };
}

async function readKey(id: string): Promise<DaytonaKey | undefined> {
  const [row] = await getDb().select().from(daytonaKeys).where(eq(daytonaKeys.id, id));
  return row;
}

function plaintextOf(ciphertext: string): string | null {
  if (ciphertext === DELETED_KEY_MARKER) return null;
  try {
    return decryptSecret(ciphertext, loadConfig().secretsEncryptionKey, DAYTONA_KEY_PURPOSE);
  } catch {
    return null;
  }
}

export async function addAdminKey(
  input: { label?: unknown; apiKey?: unknown },
): Promise<AdminKeyResult<AdminKeyView>> {
  if (typeof input.label !== "string" || typeof input.apiKey !== "string") {
    return fail(400, "invalid_request", KEY_VALIDATION_MESSAGE);
  }
  const label = input.label.trim();
  const apiKey = input.apiKey;
  if (!isValidKeyLabel(label) || !isValidApiKey(apiKey)) {
    return fail(400, "invalid_request", KEY_VALIDATION_MESSAGE);
  }

  const probe = await probeApiKey(apiKey);
  if (!probe.ok) {
    return probe.reason === "rejected"
      ? fail(400, "invalid_request", KEY_REJECTED_MESSAGE)
      : fail(502, "upstream_error", KEY_UNAVAILABLE_MESSAGE);
  }

  const sql = getSqlClient();
  const inserted = await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(${ADD_LOCK_CLASS}::int, 0)`;
    const rows = (await tx`
      select id, label, api_key_encrypted as "apiKeyEncrypted", deleted_at as "deletedAt"
      from daytona_keys`) as Array<{
      id: string;
      label: string;
      apiKeyEncrypted: string;
      deletedAt: Date | null;
    }>;
    const named = rows.find((row) => row.deletedAt === null && labelKey(row.label) === labelKey(label));
    if (named !== undefined) return fail(409, "conflict", KEY_LABEL_CONFLICT_MESSAGE);
    for (const row of rows) {
      const stored = plaintextOf(row.apiKeyEncrypted);
      if (stored !== null && sameSecret(stored, apiKey)) {
        return fail(409, "conflict", KEY_SECRET_CONFLICT_MESSAGE);
      }
    }
    const ciphertext = encryptSecret(apiKey, loadConfig().secretsEncryptionKey, DAYTONA_KEY_PURPOSE);
    const organizationUsage = probe.organizationId === null ? null : {
      source: "error",
      fetchedAt: null,
      organizationId: probe.organizationId,
      region: null,
      cpu: null,
      memoryGb: null,
      diskGb: null,
      maxPerSandbox: null,
      error: null,
    };
    const created = (await tx`
      insert into daytona_keys (label, api_key_encrypted, enabled, usage)
      values (
        ${label},
        ${ciphertext},
        true,
        ${organizationUsage === null ? null : JSON.stringify(organizationUsage)}::jsonb
      )
      returning id`) as Array<{ id: string }>;
    const id = created[0]?.id;
    if (id === undefined) return fail(502, "upstream_error", KEY_UNAVAILABLE_MESSAGE);
    return { ok: true as const, value: id };
  });
  if (!inserted.ok) return inserted;

  await refreshUsage(inserted.value, { force: true });
  const [fresh] = await getDb().select().from(daytonaKeys).where(eq(daytonaKeys.id, inserted.value));
  if (fresh === undefined) return fail(404, "not_found", "Ключ не найден.");

  const view = await present(fresh);
  if (probe.organizationId !== null && view.warning === null) {
    const keys = await getDb().select().from(daytonaKeys).orderBy(asc(daytonaKeys.createdAt), asc(daytonaKeys.id));
    const other = keys.find(
      (row) =>
        row.id !== fresh.id &&
        row.deletedAt === null &&
        storedUsage(row.usage)?.organizationId === probe.organizationId,
    );
    if (other !== undefined) return { ok: true, value: { ...view, warning: quotaShareWarning(other.label) } };
  }
  return { ok: true, value: view };
}

export async function setAdminKeyEnabled(
  id: string,
  enabled: unknown,
): Promise<AdminKeyResult<AdminKeyView>> {
  if (typeof enabled !== "boolean") {
    return fail(400, "invalid_request", "Поле enabled должно быть логическим значением.");
  }
  const current = await readKey(id);
  if (current === undefined) return fail(404, "not_found", "Ключ не найден.");
  if (current.deletedAt !== null) return fail(409, "conflict", KEY_DELETED_MESSAGE);
  const updated = enabled ? await enableKey(id) : await disableKey(id);
  if (updated === null) return fail(404, "not_found", "Ключ не найден.");
  console.info(`[admin:key] ${enabled ? "enabled" : "disabled"} ${id}`);
  return { ok: true, value: await present(updated) };
}

export async function refreshAdminKey(id: string): Promise<AdminKeyResult<AdminKeyView>> {
  const current = await readKey(id);
  if (current === undefined || current.apiKeyEncrypted === DELETED_KEY_MARKER) {
    return fail(404, "not_found", "Ключ не найден.");
  }
  const fresh =
    current.usageCheckedAt !== null &&
    Date.now() - current.usageCheckedAt.getTime() < REFRESH_MIN_MS;
  if (!fresh) await refreshUsage(id, { force: true });
  const [row] = await getDb().select().from(daytonaKeys).where(eq(daytonaKeys.id, id));
  if (row === undefined) return fail(404, "not_found", "Ключ не найден.");
  return { ok: true, value: await present(row) };
}

export async function deleteAdminKey(
  id: string,
): Promise<AdminKeyResult<{ remainingSandboxes: number }>> {
  const current = await readKey(id);
  if (current === undefined || current.apiKeyEncrypted === DELETED_KEY_MARKER) {
    return fail(404, "not_found", "Ключ не найден.");
  }
  const result = await deleteKey(id, {
    deadline: new Date(Date.now() + DELETE_BUDGET_MS),
    concurrency: DELETE_CONCURRENCY,
  });
  console.info(`[admin:key] deleted ${id}`);
  return { ok: true, value: { remainingSandboxes: result.remaining } };
}


