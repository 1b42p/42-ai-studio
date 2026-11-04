/**
 * Пул ключей Daytona: использование, выбор ключа под новую песочницу и
 * операции отключения, включения и удаления. Ключи одной организации делят
 * квоту, поэтому считаются одним пулом.
 *
 * Ключ здесь только расшифровывается на время одного запроса; значение не
 * попадает ни в журнал, ни в ошибки, ни в ответы.
 */
import { and, asc, count, eq, inArray, isNull } from "drizzle-orm";

import { loadConfig } from "@/lib/config";
import { getDb, getSqlClient } from "@/lib/db/client";
import {
  daytonaKeys,
  pendingSandboxDeletions,
  sandboxes,
  type DaytonaKey,
  type SandboxLaunch,
} from "@/lib/db/schema";
import {
  failedUsage,
  fetchUsage,
  storedUsage,
  type KeyUsage,
} from "@/lib/daytona/usage";
import { errorStatus, isMissingSandbox } from "@/lib/sandbox/errors";
import { DAYTONA_KEY_PURPOSE, decryptSecret } from "@/lib/secrets";
import { daytonaBackend } from "./daytona-backend";

/** Данные моложе 30 секунд считаются свежими. */
export const USAGE_FRESH_MS = 30_000;
/** Сколько пул считается исчерпанным после отказа по квоте. */
export const POOL_EXHAUSTED_MS = 60_000;
/** Маркер затёртого шифротекста удалённого ключа. */
export const DELETED_KEY_MARKER = "deleted";
/** Постоянный идентификатор рекомендательной блокировки пула. */
const POOL_LOCK = 20261104;

export interface KeyNeed {
  readonly cpu: number;
  readonly memoryGb: number;
  readonly diskGb: number;
}

export type PickKeyResult =
  | { readonly kind: "key"; readonly key: DaytonaKey; readonly usage: KeyUsage | null }
  | { readonly kind: "no_key" }
  | { readonly kind: "no_capacity" };

type Pool = {
  readonly usage: KeyUsage | null;
  readonly exhausted: boolean;
  readonly reserved: KeyNeed;
};

/** Минимум строки `daytona_keys` для решения под блокировкой. */
interface CandidateRow {
  id: string;
  usage: unknown;
  /** postgres.js может отдать строку вместо Date. */
  exhaustedUntil: Date | string | null;
}

const ZERO: KeyNeed = { cpu: 0, memoryGb: 0, diskGb: 0 };

function timeOf(value: Date | string | null): number {
  if (value === null) return 0;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? 0 : time;
}

function poolOf(usage: KeyUsage | null, keyId: string): string {
  return usage?.organizationId ?? `key:${keyId}`;
}

function add(target: KeyNeed, value: KeyNeed): KeyNeed {
  return {
    cpu: target.cpu + value.cpu,
    memoryGb: target.memoryGb + value.memoryGb,
    diskGb: target.diskGb + value.diskGb,
  };
}

/**
 * Обновляет `daytona_keys.usage` и `usage_checked_at`. Данные моложе
 * 30 секунд не перечитываются без `force`. Сеть читается до блокировки пула.
 */
export async function refreshUsage(
  keyId: string,
  options: { force?: boolean } = {},
): Promise<KeyUsage | null> {
  const db = getDb();
  const [row] = await db.select().from(daytonaKeys).where(eq(daytonaKeys.id, keyId));
  if (row === undefined) return null;

  const previous = storedUsage(row.usage);
  const fresh =
    row.usageCheckedAt !== null &&
    Date.now() - row.usageCheckedAt.getTime() < USAGE_FRESH_MS;
  if (options.force !== true && fresh) return previous;

  // Удалённый ключ не выбирается и не расшифровывается: последние числа
  // остаются как есть, чтобы админка не показывала выдуманную ошибку.
  if (row.apiKeyEncrypted === DELETED_KEY_MARKER) return previous;

  let usage: KeyUsage;
  try {
    const secret = decryptSecret(
      row.apiKeyEncrypted,
      loadConfig().secretsEncryptionKey,
      DAYTONA_KEY_PURPOSE,
    );
    usage = await fetchUsage(keyId, secret, previous);
  } catch {
    usage = failedUsage(previous, "unexpected", previous?.organizationId ?? null);
  }

  await db
    .update(daytonaKeys)
    .set({ usage: { ...usage }, usageCheckedAt: new Date() })
    .where(eq(daytonaKeys.id, keyId));
  return usage;
}

function hasNumbers(usage: KeyUsage | null): usage is KeyUsage & {
  cpu: NonNullable<KeyUsage["cpu"]>;
  memoryGb: NonNullable<KeyUsage["memoryGb"]>;
  diskGb: NonNullable<KeyUsage["diskGb"]>;
} {
  return usage?.cpu != null && usage.memoryGb != null && usage.diskGb != null;
}

function fits(usage: KeyUsage | null, reserved: KeyNeed, need: KeyNeed): boolean {
  // Использование прочитать не удалось и прежних чисел нет: ключ подходит.
  if (!hasNumbers(usage)) return true;
  const free = {
    cpu: usage.cpu.quota - usage.cpu.used - reserved.cpu,
    memoryGb: usage.memoryGb.quota - usage.memoryGb.used - reserved.memoryGb,
    diskGb: usage.diskGb.quota - usage.diskGb.used - reserved.diskGb,
  };
  return free.cpu >= need.cpu && free.memoryGb >= need.memoryGb && free.diskGb >= need.diskGb;
}

/**
 * Выбирает ключ под новую песочницу и под блокировкой пула резервирует строку
 * `sandboxes` в состоянии `starting`. Использование перечитывается до
 * блокировки: иначе все старты сериализовались бы по таймауту Daytona.
 */
export async function pickKey(
  need: KeyNeed,
  options: { appSessionId?: string } = {},
): Promise<PickKeyResult> {
  const db = getDb();
  const candidates = await db
    .select({ id: daytonaKeys.id })
    .from(daytonaKeys)
    .where(and(eq(daytonaKeys.enabled, true), isNull(daytonaKeys.deletedAt)))
    .orderBy(asc(daytonaKeys.createdAt), asc(daytonaKeys.id));
  if (candidates.length === 0) return { kind: "no_key" };

  for (const candidate of candidates) await refreshUsage(candidate.id);

  // Организация нужна и для строк `starting` чужих сессий, поэтому карта
  // строится по всем ключам, а не только по кандидатам.
  const keys = await db.select().from(daytonaKeys);
  const organizationByKey = new Map(
    keys.map((key) => [key.id, poolOf(storedUsage(key.usage), key.id)]),
  );
  // Блокировки берутся на пулы кандидатов в отсортированном порядке: две
  // параллельные сессии не займут последнее место, а разные организации
  // не ждут друг друга.
  const candidatePools = [...new Set(
    candidates.map((candidate) => organizationByKey.get(candidate.id) ?? poolOf(null, candidate.id)),
  )].sort();
  const config = loadConfig();
  const sandboxSize: KeyNeed = {
    cpu: config.sandboxCpu,
    memoryGb: config.sandboxMemoryGb,
    diskGb: config.sandboxDiskGb,
  };

  const sql = getSqlClient();
  const picked = await sql.begin(async (tx) => {
    for (const pool of candidatePools) {
      await tx`select pg_advisory_xact_lock(${POOL_LOCK}::int, hashtext(${pool}))`;
    }

    const rows = (await tx`
      select id, usage, exhausted_until as "exhaustedUntil"
      from daytona_keys
      where enabled = true and deleted_at is null
      order by created_at, id`) as CandidateRow[];
    if (rows.length === 0) return { kind: "no_key" } as const;

    const starting = (await tx`
      select app_session_id as "appSessionId", daytona_key_id as "daytonaKeyId",
             starting_kind as "startingKind"
      from sandboxes
      where state = 'starting' and starting_since > now() - interval '5 minutes'`) as Array<{
      appSessionId: string;
      daytonaKeyId: string;
      startingKind: SandboxLaunch | null;
    }>;

    const reserved = new Map<string, KeyNeed>();
    for (const row of starting) {
      if (options.appSessionId !== undefined && row.appSessionId === options.appSessionId) continue;
      const pool = organizationByKey.get(row.daytonaKeyId) ?? `key:${row.daytonaKeyId}`;
      // Пробуждение остановленной песочницы резервирует только vCPU и память:
      // диск уже занят ею и входит в использование Daytona.
      const size = row.startingKind === "wake"
        ? { cpu: sandboxSize.cpu, memoryGb: sandboxSize.memoryGb, diskGb: 0 }
        : sandboxSize;
      reserved.set(pool, add(reserved.get(pool) ?? ZERO, size));
    }

    const pools = new Map<string, Pool>();
    const now = Date.now();
    for (const row of rows) {
      const usage = storedUsage(row.usage);
      const poolId = poolOf(usage, row.id);
      let pool = pools.get(poolId);
      if (pool === undefined) {
        pool = {
          usage,
          exhausted: timeOf(row.exhaustedUntil) > now,
          reserved: reserved.get(poolId) ?? ZERO,
        };
        pools.set(poolId, pool);
      }
      if (pool.exhausted) continue;
      // Отозванный или истёкший ключ не выбирается, даже если числа прежние.
      if (usage?.error === "unauthorized") continue;
      if (!fits(pool.usage, pool.reserved, need)) continue;

      if (options.appSessionId !== undefined) {
        await tx`
          insert into sandboxes
            (app_session_id, daytona_key_id, daytona_sandbox_id, state, starting_since, starting_kind, last_active_at)
          values (${options.appSessionId}, ${row.id}, '', 'starting', now(), 'create', now())
          on conflict (app_session_id) do update set
            daytona_key_id = excluded.daytona_key_id,
            daytona_sandbox_id = '',
            state = 'starting',
            starting_since = excluded.starting_since,
            starting_kind = excluded.starting_kind,
            last_active_at = excluded.last_active_at`;
      }
      return { kind: "key", keyId: row.id, usage } as const;
    }
    return { kind: "no_capacity" } as const;
  });

  if (picked.kind !== "key") return picked;
  // Дата из raw-запроса может быть строкой, поэтому итоговая строка читается
  // обычным клиентом Drizzle — он приводит типы колонок.
  const [key] = await db.select().from(daytonaKeys).where(eq(daytonaKeys.id, picked.keyId));
  if (key === undefined || !key.enabled || key.deletedAt !== null) {
    return { kind: "no_capacity" };
  }
  return { kind: "key", key, usage: picked.usage };
}

/** Сколько включённых неудалённых ключей — предел числа попыток создания. */
export async function enabledKeyCount(): Promise<number> {
  const [row] = await getDb()
    .select({ value: count() })
    .from(daytonaKeys)
    .where(and(eq(daytonaKeys.enabled, true), isNull(daytonaKeys.deletedAt)));
  return Number(row?.value ?? 0);
}

/**
 * Помечает исчерпанным весь пул организации на 60 секунд. Запись ведётся на
 * всех ключах пула, чтобы отметка не потерялась при отключении представителя.
 */
export async function exhaustPool(
  keyId: string,
  until: Date = new Date(Date.now() + POOL_EXHAUSTED_MS),
): Promise<void> {
  const db = getDb();
  const [key] = await db.select().from(daytonaKeys).where(eq(daytonaKeys.id, keyId));
  if (key === undefined) return;
  const organizationId = storedUsage(key.usage)?.organizationId;
  if (organizationId == null) {
    await db.update(daytonaKeys).set({ exhaustedUntil: until }).where(eq(daytonaKeys.id, keyId));
    return;
  }
  const keys = await db.select({ id: daytonaKeys.id, usage: daytonaKeys.usage }).from(daytonaKeys);
  const ids = keys
    .filter((row) => storedUsage(row.usage)?.organizationId === organizationId)
    .map((row) => row.id);
  await db
    .update(daytonaKeys)
    .set({ exhaustedUntil: until })
    .where(inArray(daytonaKeys.id, ids.length > 0 ? ids : [keyId]));
}

/** 401 при создании: ключ отозван или истёк, выбор переходит к следующему. */
export async function markKeyUnauthorized(keyId: string): Promise<void> {
  const db = getDb();
  const [key] = await db.select().from(daytonaKeys).where(eq(daytonaKeys.id, keyId));
  if (key === undefined) return;
  const previous = storedUsage(key.usage);
  const usage = failedUsage(previous, "unauthorized", previous?.organizationId ?? null);
  await db
    .update(daytonaKeys)
    .set({ usage: { ...usage }, usageCheckedAt: new Date() })
    .where(eq(daytonaKeys.id, keyId));
}

export async function disableKey(keyId: string): Promise<DaytonaKey | null> {
  const [row] = await getDb()
    .update(daytonaKeys)
    .set({ enabled: false })
    .where(eq(daytonaKeys.id, keyId))
    .returning();
  return row ?? null;
}

export async function enableKey(keyId: string): Promise<DaytonaKey | null> {
  const [row] = await getDb()
    .update(daytonaKeys)
    .set({ enabled: true })
    .where(eq(daytonaKeys.id, keyId))
    .returning();
  return row ?? null;
}

export interface DeleteKeyResult {
  /** Песочницы, которые не удалось удалить в Daytona. */
  readonly remaining: number;
}

/**
 * Мягко удаляет ключ: `deleted_at`, `enabled = false`, затем по возможности
 * удаляет его песочницы. Шифротекст затирается маркером `deleted` только когда
 * не осталось неудалённых машин; иначе операцию можно повторить.
 */
export async function deleteKey(keyId: string): Promise<DeleteKeyResult> {
  const db = getDb();
  const [key] = await db.select().from(daytonaKeys).where(eq(daytonaKeys.id, keyId));
  if (key === undefined) return { remaining: 0 };

  await db
    .update(daytonaKeys)
    .set({ deletedAt: new Date(), enabled: false })
    .where(eq(daytonaKeys.id, keyId));

  const rows = await db.select().from(sandboxes).where(eq(sandboxes.daytonaKeyId, keyId));
  const pending = await db
    .select()
    .from(pendingSandboxDeletions)
    .where(eq(pendingSandboxDeletions.daytonaKeyId, keyId));

  // Резерв без машины: создание может идти прямо сейчас. Оставляем строку
  // живой и сохраняем шифротекст — повтор удалит появившуюся машину.
  let remaining = rows.filter(
    (row) => row.state !== "gone" && row.daytonaSandboxId === "",
  ).length;

  // Цели — живые строки и машины, удаление которых уже сорвалось раньше.
  // `gone` без записи в pending считается удалённой в Daytona.
  const targets = new Map<string, string[]>();
  for (const row of rows) {
    if (row.state === "gone" || row.daytonaSandboxId === "") continue;
    targets.set(row.daytonaSandboxId, [...(targets.get(row.daytonaSandboxId) ?? []), row.id]);
  }
  for (const entry of pending) {
    if (!targets.has(entry.daytonaSandboxId)) targets.set(entry.daytonaSandboxId, []);
  }

  if (key.apiKeyEncrypted === DELETED_KEY_MARKER) {
    return { remaining: remaining + targets.size };
  }

  let backend: ReturnType<typeof daytonaBackend>;
  try {
    backend = daytonaBackend(
      key.id,
      decryptSecret(key.apiKeyEncrypted, loadConfig().secretsEncryptionKey, DAYTONA_KEY_PURPOSE),
    );
  } catch {
    return { remaining: remaining + targets.size };
  }

  // Строку могли уже занять новой песочницей и ключом, пока удаление шло по
  // сети: отмечаем `gone` только ту же пару «ключ + машина».
  const markGone = async (rowIds: string[], sandboxId: string): Promise<void> => {
    if (rowIds.length === 0) return;
    await db
      .update(sandboxes)
      .set({ state: "gone" })
      .where(and(
        inArray(sandboxes.id, rowIds),
        eq(sandboxes.daytonaKeyId, keyId),
        eq(sandboxes.daytonaSandboxId, sandboxId),
      ));
  };

  for (const [sandboxId, rowIds] of targets) {
    // Идентификатор запоминается до сетевого удаления: падение процесса
    // между запросом и подтверждением не потеряет машину.
    await db
      .insert(pendingSandboxDeletions)
      .values({ daytonaKeyId: keyId, daytonaSandboxId: sandboxId })
      .onConflictDoNothing();
    try {
      const machine = await backend.get(sandboxId);
      await machine.delete();
      await db
        .delete(pendingSandboxDeletions)
        .where(and(
          eq(pendingSandboxDeletions.daytonaKeyId, keyId),
          eq(pendingSandboxDeletions.daytonaSandboxId, sandboxId),
        ));
      await markGone(rowIds, sandboxId);
    } catch (error) {
      if (isMissingSandbox(error)) {
        await db
          .delete(pendingSandboxDeletions)
          .where(and(
            eq(pendingSandboxDeletions.daytonaKeyId, keyId),
            eq(pendingSandboxDeletions.daytonaSandboxId, sandboxId),
          ));
        await markGone(rowIds, sandboxId);
      } else {
        remaining += 1;
      }
    }
  }

  if (remaining === 0) {
    await db
      .delete(pendingSandboxDeletions)
      .where(eq(pendingSandboxDeletions.daytonaKeyId, keyId));
    await db
      .update(daytonaKeys)
      .set({ apiKeyEncrypted: DELETED_KEY_MARKER })
      .where(eq(daytonaKeys.id, keyId));
  }
  return { remaining };
}

/** Daytona отказала по квоте: `400` и сообщение «Total … limit exceeded». */
export function isQuotaExceeded(error: unknown): boolean {
  if (errorStatus(error) !== 400) return false;
  const message = error instanceof Error ? error.message : "";
  return message.startsWith("Total") && message.includes("limit exceeded");
}
