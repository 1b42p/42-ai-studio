/**
 * Список пользователей для админки: разбор запроса, курсор по
 * (`created_at`, `id`) и выборка. По `username` ищется через `strpos`:
 * `LIKE` и `ILIKE` превращали бы `_` из настоящего имени в шаблон.
 */
import { and, desc, eq, isNull, lt, or, sql, type SQL } from "drizzle-orm";

import { getDb } from "../db/client";
import { users } from "../db/schema";
import { isUuid } from "../sessions/access";
import type { AdminUserItem, AdminUsersPage, AdminUsersTotals } from "./types";

export const ADMIN_USERS_DEFAULT_LIMIT = 50;
export const ADMIN_USERS_MAX_LIMIT = 100;
const MAX_QUERY_LENGTH = 64;

export interface AdminUsersRequest {
  readonly q: string;
  readonly limit: number;
  readonly cursor: AdminUsersCursor | null;
  readonly userId: string | null;
}

export interface AdminUsersCursor {
  readonly createdAt: Date;
  readonly id: string;
}

export type ParsedAdminUsers =
  | { readonly ok: true; readonly request: AdminUsersRequest }
  | { readonly ok: false; readonly message: string };

interface CursorPayload {
  createdAt?: unknown;
  id?: unknown;
}

export function encodeAdminUsersCursor(createdAt: Date, id: string): string {
  return Buffer.from(
    JSON.stringify({ createdAt: createdAt.toISOString(), id }),
    "utf8",
  ).toString("base64url");
}

export function decodeAdminUsersCursor(value: string): AdminUsersCursor | null {
  if (value === "") return null;
  let payload: CursorPayload;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (parsed === null || typeof parsed !== "object") return null;
    payload = parsed;
  } catch {
    return null;
  }
  if (typeof payload.createdAt !== "string" || typeof payload.id !== "string") return null;
  if (!isUuid(payload.id)) return null;
  const createdAt = new Date(payload.createdAt);
  if (Number.isNaN(createdAt.getTime())) return null;
  return { createdAt, id: payload.id };
}

/** Ведущий `@` — привычная запись username; пустая строка после него — без фильтра. */
export function normalizeAdminUsersQuery(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
}

export function parseAdminUsersSearchParams(params: URLSearchParams): ParsedAdminUsers {
  const q = normalizeAdminUsersQuery(params.get("q") ?? "");
  if (Array.from(q).length > MAX_QUERY_LENGTH) {
    return { ok: false, message: "Параметр q не длиннее 64 символов" };
  }

  const rawLimit = params.get("limit");
  let limit = ADMIN_USERS_DEFAULT_LIMIT;
  if (rawLimit !== null) {
    if (!/^\d+$/.test(rawLimit)) {
      return { ok: false, message: "Параметр limit должен быть целым числом от 1 до 100" };
    }
    limit = Number(rawLimit);
    if (limit < 1 || limit > ADMIN_USERS_MAX_LIMIT) {
      return { ok: false, message: "Параметр limit должен быть целым числом от 1 до 100" };
    }
  }

  const rawCursor = params.get("cursor");
  let cursor: AdminUsersCursor | null = null;
  if (rawCursor !== null) {
    cursor = decodeAdminUsersCursor(rawCursor);
    if (cursor === null) return { ok: false, message: "Параметр cursor некорректен" };
  }

  const rawUserId = params.get("userId");
  let userId: string | null = null;
  if (rawUserId !== null && rawUserId !== "") {
    if (!isUuid(rawUserId)) return { ok: false, message: "Параметр userId некорректен" };
    userId = rawUserId;
  }

  return { ok: true, request: { q, limit, cursor, userId } };
}

interface UserRow {
  id: string;
  telegramId: number;
  name: string;
  username: string | null;
  photoUrl: string | null;
  isOperator: boolean;
  isBlocked: boolean;
  deletionRequestedAt: Date | null;
  createdAt: Date;
  lastLoginAt: Date | null;
  sessionCount: number;
  stuckDeletions: number;
}

function userSelection() {
  return {
    id: users.id,
    telegramId: users.telegramId,
    name: users.name,
    username: users.username,
    photoUrl: users.photoUrl,
    isOperator: users.isOperator,
    isBlocked: users.isBlocked,
    deletionRequestedAt: users.deletionRequestedAt,
    createdAt: users.createdAt,
    lastLoginAt: users.lastLoginAt,
    sessionCount: sql<number>`(
      select count(*)::int from app_sessions as s
      where s.user_id = ${sql.raw('"users"."id"')}
        and s.eve_session_id is not null
        and s.deleted_at is null
    )`,
    stuckDeletions: sql<number>`(
      select count(*)::int from app_sessions as s
      where s.user_id = ${sql.raw('"users"."id"')}
        and s.deleted_at < now() - interval '1 hour'
    )`,
  };
}

function toItem(row: UserRow): AdminUserItem {
  return {
    id: row.id,
    telegramId: row.telegramId.toString(),
    name: row.name,
    username: row.username,
    photoUrl: row.photoUrl,
    isOperator: row.isOperator,
    isBlocked: row.isBlocked,
    deletionRequestedAt: row.deletionRequestedAt?.toISOString() ?? null,
    sessionCount: row.sessionCount,
    stuckDeletions: row.stuckDeletions,
    createdAt: row.createdAt.toISOString(),
    lastLoginAt: row.lastLoginAt?.toISOString() ?? null,
  };
}

async function totals(): Promise<AdminUsersTotals> {
  const [row] = await getDb()
    .select({
      users: sql<number>`count(*)::int`,
      operators: sql<number>`count(*) filter (where ${users.isOperator})::int`,
      blocked: sql<number>`count(*) filter (where ${users.isBlocked})::int`,
    })
    .from(users);
  return row ?? { users: 0, operators: 0, blocked: 0 };
}

export async function listAdminUsers(request: AdminUsersRequest): Promise<AdminUsersPage> {
  const conditions: SQL[] = [];
  if (request.userId !== null) conditions.push(eq(users.id, request.userId));
  if (request.q !== "") {
    conditions.push(
      sql`(
        strpos(${users.telegramId}::text, ${request.q}) = 1
        or strpos(lower(${users.username}), lower(${request.q})) > 0
      )`,
    );
  }
  if (request.cursor !== null) {
    const older = or(
      lt(users.createdAt, request.cursor.createdAt),
      and(
        eq(users.createdAt, request.cursor.createdAt),
        lt(users.id, request.cursor.id),
      ),
    );
    if (older !== undefined) conditions.push(older);
  }

  const [rows, counts] = await Promise.all([
    getDb()
      .select(userSelection())
      .from(users)
      .where(conditions.length === 0 ? undefined : and(...conditions))
      .orderBy(desc(users.createdAt), desc(users.id))
      .limit(request.limit + 1),
    totals(),
  ]);

  const hasMore = rows.length > request.limit;
  const page = hasMore ? rows.slice(0, request.limit) : rows;
  const last = page.at(-1);
  return {
    items: page.map(toItem),
    nextCursor:
      hasMore && last !== undefined
        ? encodeAdminUsersCursor(last.createdAt, last.id)
        : null,
    totals: counts,
  };
}

export async function getAdminUser(userId: string): Promise<AdminUserItem | null> {
  const [row] = await getDb()
    .select(userSelection())
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return row === undefined ? null : toItem(row);
}

export type BlockUserResult =
  | { readonly status: "updated"; readonly item: AdminUserItem }
  | { readonly status: "not_found" }
  | { readonly status: "conflict"; readonly message: string };

/**
 * Блокировка и разблокировка одним условным обновлением: проверка
 * `deletion_requested_at` и запись `is_blocked` не разрываются параллельным
 * удалением. Оператора нельзя заблокировать, но разблокировать можно.
 */
export async function setUserBlocked(input: {
  operatorId: string;
  userId: string;
  blocked: boolean;
}): Promise<BlockUserResult> {
  const where = input.blocked
    ? and(eq(users.id, input.userId), eq(users.isOperator, false))
    : and(eq(users.id, input.userId), isNull(users.deletionRequestedAt));

  const [updated] = await getDb()
    .update(users)
    .set({ isBlocked: input.blocked })
    .where(where)
    .returning({ id: users.id });

  if (updated !== undefined) {
    const item = await getAdminUser(input.userId);
    if (item === null) return { status: "not_found" };
    console.info(`[admin:user] ${input.blocked ? "blocked" : "unblocked"}`, {
      operatorId: input.operatorId,
      userId: input.userId,
    });
    return { status: "updated", item };
  }

  const [target] = await getDb()
    .select({
      id: users.id,
      isOperator: users.isOperator,
      deletionRequestedAt: users.deletionRequestedAt,
    })
    .from(users)
    .where(eq(users.id, input.userId))
    .limit(1);
  if (target === undefined) return { status: "not_found" };

  if (input.blocked) {
    return {
      status: "conflict",
      message: "Нельзя заблокировать оператора. Сначала снимите флаг оператора в базе.",
    };
  }
  return {
    status: "conflict",
    message: "Пользователь удаляется, разблокировать нельзя.",
  };
}
