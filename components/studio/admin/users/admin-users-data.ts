/** Запросы раздела «Пользователи»; компоненты списка их не вызывают сами. */
import type {
  AdminUserDeleteResponse,
  AdminUserItem,
  AdminUsersPage,
} from "@/lib/admin/types";

export interface AdminUsersQuery {
  readonly q: string;
  readonly cursor?: string;
  readonly userId?: string | null;
}

export class AdminUsersError extends Error {}

function messageFrom(body: unknown): string | null {
  if (body === null || typeof body !== "object" || !("error" in body)) return null;
  const error = (body as { error?: unknown }).error;
  if (error === null || typeof error !== "object" || !("message" in error)) return null;
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" && message.trim() !== "" ? message : null;
}

async function readError(response: Response, fallback: string): Promise<AdminUsersError> {
  const body: unknown = await response.json().catch(() => null);
  return new AdminUsersError(messageFrom(body) ?? fallback);
}

export async function fetchAdminUsers(input: AdminUsersQuery): Promise<AdminUsersPage> {
  const params = new URLSearchParams();
  if (input.q !== "") params.set("q", input.q);
  if (input.cursor !== undefined && input.cursor !== "") params.set("cursor", input.cursor);
  if (input.userId !== null && input.userId !== undefined) params.set("userId", input.userId);
  const query = params.toString();

  const response = await fetch(query === "" ? "/api/admin/users" : `/api/admin/users?${query}`);
  if (!response.ok) throw await readError(response, "Не удалось загрузить пользователей");
  return (await response.json()) as AdminUsersPage;
}

export async function patchAdminUser(id: string, blocked: boolean): Promise<AdminUserItem> {
  const response = await fetch(`/api/admin/users/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ blocked }),
  });
  if (!response.ok) throw await readError(response, "Не удалось изменить блокировку");
  return (await response.json()) as AdminUserItem;
}

/** 404 после завершённого удаления — тоже успех: клиент повторил запрос. */
export async function deleteAdminUser(id: string): Promise<AdminUserDeleteResponse> {
  const response = await fetch(`/api/admin/users/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (response.status === 204 || response.status === 404) return { done: true };
  if (response.status === 202) {
    const body = (await response.json()) as {
      done?: unknown;
      deleted?: unknown;
      total?: unknown;
      remaining?: { sessions?: unknown };
    };
    if (
      body.done === false &&
      typeof body.deleted === "number" &&
      typeof body.total === "number" &&
      typeof body.remaining?.sessions === "number"
    ) {
      return {
        done: false,
        deleted: body.deleted,
        total: body.total,
        remaining: { sessions: body.remaining.sessions },
      };
    }
    throw new AdminUsersError("Не удалось полностью удалить пользователя. Повторите удаление.");
  }
  throw await readError(response, "Не удалось полностью удалить пользователя. Повторите удаление.");
}
