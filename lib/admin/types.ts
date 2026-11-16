/** Данные админки, общие для серверных маршрутов и компонентов списка. */

export interface AdminUserItem {
  readonly id: string;
  /** Telegram ID строкой: `bigint` в JSON теряет точность. */
  readonly telegramId: string;
  readonly name: string;
  readonly username: string | null;
  readonly photoUrl: string | null;
  readonly isOperator: boolean;
  readonly isBlocked: boolean;
  readonly deletionRequestedAt: string | null;
  readonly sessionCount: number;
  readonly stuckDeletions: number;
  readonly createdAt: string;
  readonly lastLoginAt: string | null;
}

export interface AdminUsersTotals {
  readonly users: number;
  readonly operators: number;
  readonly blocked: number;
}

export interface AdminUsersPage {
  readonly items: readonly AdminUserItem[];
  readonly nextCursor: string | null;
  readonly totals: AdminUsersTotals;
}

/** Ответ DELETE: удаление идёт пачками, клиент повторяет запрос. */
export type AdminUserDeleteResponse =
  | { readonly done: true }
  | {
      readonly done: false;
      readonly deleted: number;
      readonly total: number;
      readonly remaining: { readonly sessions: number };
    };
