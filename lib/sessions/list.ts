/**
 * Список сессий пользователя: разбор запроса, курсор по (updated_at, id)
 * и выборка. Поиск идёт по `title_search`, а не по `lower()` в SQL:
 * регистр в Postgres зависит от локали базы.
 */
import { and, desc, eq, isNotNull, lt, or, sql, type SQL } from "drizzle-orm";

import { getDb } from "../db/client";
import { appSessions } from "../db/schema";
import { isUuid } from "./access";
import { titleSearchKey } from "./title";

export const SESSION_LIST_DEFAULT_LIMIT = 30;
export const SESSION_LIST_MAX_LIMIT = 100;
const MAX_QUERY_LENGTH = 100;

export interface SessionListItem {
  readonly id: string;
  readonly title: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly preview: { readonly mediaId: string } | null;
}

export interface SessionListPage {
  readonly items: SessionListItem[];
  readonly nextCursor: string | null;
}

export interface SessionListCursor {
  readonly updatedAt: Date;
  readonly id: string;
}

export interface SessionListRequest {
  /** Уже обрезан и приведён к ключу поиска. Пустая строка — без фильтра. */
  readonly q: string;
  readonly limit: number;
  readonly cursor: SessionListCursor | null;
}

export type ParsedSessionList =
  | { readonly ok: true; readonly request: SessionListRequest }
  | { readonly ok: false; readonly message: string };

interface CursorPayload {
  updatedAt?: unknown;
  id?: unknown;
}

/** Курсор из последней отданной строки: время уже округлено столбцом до миллисекунд. */
export function encodeSessionCursor(updatedAt: Date, id: string): string {
  return Buffer.from(JSON.stringify({ updatedAt: updatedAt.toISOString(), id }), "utf8").toString(
    "base64url",
  );
}

export function decodeSessionCursor(value: string): SessionListCursor | null {
  if (value === "") return null;
  let payload: CursorPayload;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (parsed === null || typeof parsed !== "object") return null;
    payload = parsed;
  } catch {
    return null;
  }
  if (typeof payload.updatedAt !== "string" || typeof payload.id !== "string") return null;
  if (!isUuid(payload.id)) return null;
  const updatedAt = new Date(payload.updatedAt);
  if (Number.isNaN(updatedAt.getTime())) return null;
  return { updatedAt, id: payload.id };
}

/** Экранирует `\`, `%` и `_`, чтобы LIKE искал подстроку, а не шаблон. */
export function likePattern(query: string): string {
  const escaped = query.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
  return `%${escaped}%`;
}

export function parseSessionListSearchParams(params: URLSearchParams): ParsedSessionList {
  const rawQuery = params.get("q");
  const trimmed = rawQuery === null ? "" : rawQuery.trim();
  if (Array.from(trimmed).length > MAX_QUERY_LENGTH) {
    return { ok: false, message: "Параметр q не длиннее 100 символов" };
  }

  const rawLimit = params.get("limit");
  let limit = SESSION_LIST_DEFAULT_LIMIT;
  if (rawLimit !== null) {
    if (!/^\d+$/.test(rawLimit)) {
      return { ok: false, message: "Параметр limit должен быть целым числом от 1 до 100" };
    }
    limit = Number(rawLimit);
    if (limit < 1 || limit > SESSION_LIST_MAX_LIMIT) {
      return { ok: false, message: "Параметр limit должен быть целым числом от 1 до 100" };
    }
  }

  const rawCursor = params.get("cursor");
  let cursor: SessionListCursor | null = null;
  if (rawCursor !== null) {
    cursor = decodeSessionCursor(rawCursor);
    if (cursor === null) return { ok: false, message: "Параметр cursor некорректен" };
  }

  return { ok: true, request: { q: titleSearchKey(trimmed), limit, cursor } };
}

function toItem(row: {
  id: string;
  title: string | null;
  createdAt: Date;
  updatedAt: Date;
  previewMediaId: string | null;
}): SessionListItem {
  return {
    id: row.id,
    title: row.title,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    preview: row.previewMediaId === null ? null : { mediaId: row.previewMediaId },
  };
}

/**
 * Следующая страница при порядке DESC — строки строго меньше курсора:
 * updated_at меньше, либо updated_at равен и id меньше.
 */
export async function listUserSessions(
  userId: string,
  request: SessionListRequest,
): Promise<SessionListPage> {
  const conditions: SQL[] = [
    eq(appSessions.userId, userId),
    isNotNull(appSessions.eveSessionId),
  ];
  if (request.q !== "") {
    conditions.push(
      sql`${appSessions.titleSearch} like ${likePattern(request.q)} escape '\\'`,
    );
  }
  if (request.cursor !== null) {
    const older = or(
      lt(appSessions.updatedAt, request.cursor.updatedAt),
      and(
        eq(appSessions.updatedAt, request.cursor.updatedAt),
        lt(appSessions.id, request.cursor.id),
      ),
    );
    if (older !== undefined) conditions.push(older);
  }

  const rows = await getDb()
    .select({
      id: appSessions.id,
      title: appSessions.title,
      createdAt: appSessions.createdAt,
      updatedAt: appSessions.updatedAt,
      previewMediaId: appSessions.previewMediaId,
    })
    .from(appSessions)
    .where(and(...conditions))
    .orderBy(desc(appSessions.updatedAt), desc(appSessions.id))
    .limit(request.limit + 1);

  const hasMore = rows.length > request.limit;
  const page = hasMore ? rows.slice(0, request.limit) : rows;
  const last = page.at(-1);
  return {
    items: page.map(toItem),
    nextCursor:
      hasMore && last !== undefined ? encodeSessionCursor(last.updatedAt, last.id) : null,
  };
}
