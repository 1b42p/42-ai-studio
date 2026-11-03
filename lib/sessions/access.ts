/**
 * Привязка сессий eve к сессиям приложения и проверка владельца.
 *
 * Маршруты `/eve/v1/session/*` сами владельца не проверяют, поэтому канал eve
 * делает это в аутентификаторе: на создании — по заголовку
 * `x-studio-session-id`, на остальных — по привязке идентификатора сессии eve.
 *
 * Копия агента (#12) — тоже сессия eve: её поток читается теми же учётными
 * данными. Строка `agent_sessions` разрешает только чтение потока; сообщения,
 * `cancel`, `clear`, `compact` и `reset` копии ломают задачу корня, поэтому
 * закрыты.
 */
import type { User } from "../db/schema";
import { sleep } from "../sleep";
import {
  findAgentSessionByEveId,
  hasRecentSessionActivity,
  waitForAgentSession,
} from "./agent-sessions";
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

/** Сколько ждать строки `agent_sessions` для только что открытой копии. */
export const COPY_BINDING_WAIT_MS = 3_000;
/** Опрос строки копии: событие в потоке появляется раньше записи в базу. */
export const COPY_BINDING_POLL_MS = 200;
/** Окно активности пользователя, за которое копию уже могли открыть. */
export const RECENT_ACTIVITY_WINDOW_MS = 5 * 60_000;

/** Что маршрут делает с сессией eve: читает поток или меняет сессию. */
export type EveSessionAction = "stream" | "write";

export type EveRoute =
  | { readonly kind: "health" }
  | { readonly kind: "info" }
  | { readonly kind: "other" }
  | { readonly kind: "session-create" }
  | {
      readonly kind: "session";
      readonly sessionId: string;
      readonly action: EveSessionAction;
    };

/**
 * Что это за маршрут eve. Префиксы перед `/eve/v1` игнорируются, поэтому
 * проверка работает и при монтировании агента под другим путём.
 */
export function parseEveRoute(method: string, url: string): EveRoute {
  const pathname = new URL(url).pathname;
  const marker = "/eve/v1";
  const index = pathname.indexOf(marker);
  const suffix = index === -1 ? pathname : pathname.slice(index + marker.length);
  const verb = method.toUpperCase();

  if (suffix === "/health") return { kind: "health" };
  if (suffix === "/info") return { kind: "info" };

  if (suffix === "/session" || suffix === "/session/") {
    return verb === "POST" ? { kind: "session-create" } : { kind: "other" };
  }

  const match = /^\/session\/([^/]+)(\/.*)?$/.exec(suffix);
  if (match === null || match[1] === undefined) return { kind: "other" };

  try {
    return {
      kind: "session",
      sessionId: decodeURIComponent(match[1]),
      action: verb === "GET" && match[2] === "/stream" ? "stream" : "write",
    };
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
 * Ступень доступа к конкретной сессии eve. Решения проверяются по порядку,
 * первое совпадение решает:
 *
 * 1. нет входа — отказ ещё до этой функции;
 * 2. корневая сессия этого пользователя — правила #5 для всех методов;
 * 3. копия агента этого пользователя — только чтение потока;
 * 4. известная сессия — чужая, отказ сразу;
 * 5. неизвестный идентификатор и `GET …/stream`: ждём привязку корня, пока
 *    у сессии приложения `eve_session_id` пуст (клиент открывает поток сразу
 *    после создания), затем строку `agent_sessions`, если у пользователя была
 *    активность за последние пять минут;
 * 6. остальное — отказ сразу, без ожидания.
 */
export async function assertEveSessionAccess(
  user: User,
  eveSessionId: string,
  action: EveSessionAction = "write",
): Promise<void> {
  const root = await findAppSessionByEveId(eveSessionId);
  if (root !== null) {
    if (root.userId === user.id) return;
    throw forbiddenSession();
  }

  const copy = await findAgentSessionByEveId(eveSessionId);
  if (copy !== null) {
    if (copy.userId === user.id && action === "stream") return;
    throw forbiddenSession();
  }

  if (action === "stream") {
    const starting = await findStartingAppSession(user.id);
    if (starting !== null) {
      const bound = await waitForRootBinding(eveSessionId);
      if (bound !== null) {
        if (bound.userId === user.id) return;
        throw forbiddenSession();
      }
    }

    if (await hasRecentSessionActivity(user.id, RECENT_ACTIVITY_WINDOW_MS)) {
      const opened = await waitForAgentSession(eveSessionId, {
        timeoutMs: COPY_BINDING_WAIT_MS,
        pollMs: COPY_BINDING_POLL_MS,
      });
      if (opened !== null) {
        if (opened.userId === user.id) return;
        throw forbiddenSession();
      }
    }
  }

  throw forbiddenSession();
}

function forbiddenSession(): SessionAccessError {
  return new SessionAccessError("session_forbidden", "Сессия недоступна");
}

/** Ждёт привязки идентификатора eve к сессии приложения до 10 секунд. */
async function waitForRootBinding(eveSessionId: string) {
  const deadline = Date.now() + BINDING_WAIT_MS;
  while (Date.now() < deadline) {
    await sleep(BINDING_POLL_MS);
    const bound = await findAppSessionByEveId(eveSessionId);
    if (bound !== null) return bound;
  }
  return null;
}
