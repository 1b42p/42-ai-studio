/**
 * Привязка сессий eve к сессиям приложения и проверка владельца.
 *
 * Маршруты `/eve/v1/session/*` сами владельца не проверяют, поэтому канал eve
 * делает это в аутентификаторе: на создании — по заголовку
 * `x-studio-session-id`, на остальных — по привязке идентификатора сессии eve.
 */
import type { User } from "../db/schema";
import { sleep } from "../sleep";
import {
  claimSessionStart,
  findAppSessionById,
  findAppSessionByEveId,
  findStartingAppSession,
} from "./service";

/** Коды отказа, которые клиент чата переводит на русский. */
export type SessionAccessCode =
  | "session_already_started"
  | "session_binding_required"
  | "session_forbidden"
  | "session_not_found";

export class SessionAccessError extends Error {
  readonly code: SessionAccessCode;

  constructor(code: SessionAccessCode, message: string) {
    super(message);
    this.name = "SessionAccessError";
    this.code = code;
  }
}

/** Заголовок клиента чата с идентификатором сессии приложения. */
export const APP_SESSION_HEADER = "x-studio-session-id";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Идентификатор сессии приложения: uuid из адреса и заголовка. */
export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

/** Сколько ждать привязки сессии eve, открытой сразу после создания. */
export const BINDING_WAIT_MS = 10_000;
const BINDING_POLL_MS = 100;

export type EveRoute =
  | { readonly kind: "health" }
  | { readonly kind: "info" }
  | { readonly kind: "other" }
  | { readonly kind: "session-create" }
  | { readonly kind: "session"; readonly sessionId: string };

/**
 * Что это за маршрут eve. Префиксы перед `/eve/v1` игнорируются, поэтому
 * проверка работает и при монтировании агента под другим путём.
 */
export function parseEveRoute(method: string, url: string): EveRoute {
  const pathname = new URL(url).pathname;
  const marker = "/eve/v1";
  const index = pathname.indexOf(marker);
  const suffix = index === -1 ? pathname : pathname.slice(index + marker.length);

  if (suffix === "/health") return { kind: "health" };
  if (suffix === "/info") return { kind: "info" };

  if (suffix === "/session" || suffix === "/session/") {
    return method.toUpperCase() === "POST" ? { kind: "session-create" } : { kind: "other" };
  }

  const match = /^\/session\/([^/]+)(?:\/|$)/.exec(suffix);
  if (match === null || match[1] === undefined) return { kind: "other" };

  try {
    return { kind: "session", sessionId: decodeURIComponent(match[1]) };
  } catch {
    return { kind: "other" };
  }
}

/**
 * Ступень создания: заголовок должен быть uuid свободной сессии этого
 * пользователя. Атомарно отмечает начало создания и возвращает её id.
 */
export async function claimSessionStartForUser(
  user: User,
  header: string | null,
): Promise<string> {
  if (header === null || !isUuid(header)) {
    throw new SessionAccessError(
      "session_binding_required",
      "Не указана сессия приложения для создания сессии eve",
    );
  }

  const claimed = await claimSessionStart(header, user.id);
  if (claimed !== null) return claimed.id;

  const session = await findAppSessionById(header);
  if (session === null || session.userId !== user.id) {
    throw new SessionAccessError("session_not_found", "Сессия не найдена");
  }
  throw new SessionAccessError("session_already_started", "Сессия уже начата");
}

/**
 * Ступень доступа к конкретной сессии eve: она должна быть привязана к сессии
 * приложения этого пользователя. Пока привязки нет, но у пользователя идёт
 * создание сессии (не дольше 60 секунд), ждём привязки до 10 секунд — клиент
 * открывает поток сразу после ответа на создание.
 */
export async function assertEveSessionAccess(user: User, eveSessionId: string): Promise<void> {
  const bound = await findAppSessionByEveId(eveSessionId);
  if (bound !== null) {
    if (bound.userId === user.id) return;
    throw new SessionAccessError("session_forbidden", "Сессия недоступна");
  }

  const starting = await findStartingAppSession(user.id);
  if (starting === null) {
    throw new SessionAccessError("session_forbidden", "Сессия недоступна");
  }

  const deadline = Date.now() + BINDING_WAIT_MS;
  while (Date.now() < deadline) {
    await sleep(BINDING_POLL_MS);
    const nowBound = await findAppSessionByEveId(eveSessionId);
    if (nowBound === null) continue;
    if (nowBound.userId === user.id) return;
    throw new SessionAccessError("session_forbidden", "Сессия недоступна");
  }

  throw new SessionAccessError("session_forbidden", "Сессия недоступна");
}
