/**
 * Канал eve: серверная сессия входа и отдельный локальный режим оценок.
 * `localDev()`, `vercelOidc()` и `placeholderAuth()` не подключаются: иначе
 * тесты доступа ничего бы не доказывали.
 *
 * Вторая ступень проверяет принадлежность сессии eve: на создании — по
 * заголовку `x-studio-session-id`, на остальных маршрутах — по привязке
 * идентификатора сессии eve к сессии приложения этого пользователя.
 */
import { extractBearerToken, ForbiddenError, UnauthenticatedError, type AuthFn, type AuthResult } from "eve/channels/auth";
import { eveChannel } from "eve/channels/eve";
import { decodeJwt, errors } from "jose";

import { fetchUserAttachment } from "@/agent/lib/attachment-fetch";
import { authenticateEval } from "../lib/eval-auth";
import { getUserFromRequest } from "@/lib/auth/request";
import { verifyInternalToken } from "@/lib/auth/internal-tokens";
import { loadConfig, readUploadMaxBytes } from "@/lib/config";
import type { User } from "@/lib/db/schema";
import { removeSandboxQueueEntry } from "@/lib/sandbox/queue-state";
import { isUserEveSession } from "@/lib/sessions/agent-sessions";
import {
  APP_SESSION_HEADER,
  assertEveSessionAccess,
  claimSessionStartForUser,
  parseEveRoute,
  SessionAccessError,
} from "@/lib/sessions/access";

const INFO_ROUTE_PATH = "/eve/v1/info";

/** Непроверенный iss выбирает ветку, но никогда не даёт полномочий. */
async function authenticateInternal(request: Request): Promise<AuthResult | null> {
  const token = extractBearerToken(request.headers.get("authorization"));
  if (!token) return null;
  try {
    if (decodeJwt(token).iss !== "studio-app") return null;
  } catch {
    return null;
  }

  let payload;
  try {
    payload = await verifyInternalToken(token);
  } catch (error) {
    if (!(error instanceof errors.JOSEError)) throw error;
    throw new UnauthenticatedError({ code: "invalid_internal_token", message: "Служебный токен недействителен" });
  }

  const route = /^\/eve\/v1\/session\/([^/]+)\/(cancel|reset)$/.exec(new URL(request.url).pathname);
  if (payload.purpose !== "eve_session_end" || typeof payload.sid !== "string" ||
    request.method !== "POST" || route === null || route[1] !== payload.sid) {
    throw new ForbiddenError({ code: "internal_token_forbidden", message: "Служебный токен не разрешает этот запрос" });
  }
  return {
    authenticator: "studio-internal", principalType: "service", principalId: "studio-app", attributes: {},
  };
}

/** Кто пришёл: пользователь по cookie `studio_session` или никто. */
async function resolveAuthenticatedUser(request: Request): Promise<User | null> {
  return getUserFromRequest(request);
}

/**
 * Что этому пользователю разрешено на маршруте. Инструкции, инструменты и
 * навыки агента видит только оператор.
 */
function assertRouteAllowed(user: User, request: Request): void {
  if (user.isBlocked) {
    throw new ForbiddenError({ code: "user_blocked", message: "Доступ закрыт" });
  }

  const pathname = new URL(request.url).pathname;
  if (pathname === INFO_ROUTE_PATH && !user.isOperator) {
    throw new ForbiddenError({ code: "forbidden", message: "Доступ закрыт" });
  }
}

/** Отказ ступени привязки в формате ошибок eve. */
function forbidden(error: unknown): never {
  if (error instanceof SessionAccessError) {
    throw new ForbiddenError({ code: error.code, message: error.message });
  }
  throw error;
}

/** Принципал eve для пользователя; подмены инструментов — только в тестах. */
export function sessionAuthFor(
  user: User,
  appTestMode: boolean,
  appSessionId?: string,
): AuthResult {
  const attributes: Record<string, string> = { telegramId: String(user.telegramId) };
  if (appSessionId !== undefined) attributes.appSessionId = appSessionId;

  return {
    authenticator: "studio",
    principalType: "user",
    principalId: user.id,
    attributes,
    ...(appTestMode ? { allowToolStubs: true } : {}),
  };
}

export function studioAuth(): AuthFn<Request> {
  return async (request): Promise<AuthResult | null> => {
    const config = loadConfig();
    const internalPrincipal = await authenticateInternal(request);
    if (internalPrincipal !== null) return internalPrincipal;
    const evalPrincipal = authenticateEval(request, config);
    if (evalPrincipal !== null) {
      const route = parseEveRoute(request.method, request.url);
      // Eval-token не даёт доступ к пользовательским корням и копиям.
      // Только чтение: оценки не создают строки в пользовательской БД.
      if (route.kind === "session") {
        if (await isUserEveSession(route.sessionId)) {
          throw new ForbiddenError({ code: "session_forbidden", message: "Сессия недоступна" });
        }
      }
      return evalPrincipal;
    }

    if (config.appVideoEvalSandbox || config.appStubEvalSandbox) {
      throw new ForbiddenError({ code: "eval_only", message: "Этот экземпляр доступен только оценкам" });
    }

    const user = await resolveAuthenticatedUser(request);
    if (user === null) return null;

    assertRouteAllowed(user, request);

    const route = parseEveRoute(request.method, request.url);
    let appSessionId: string | undefined;

    if (route.kind === "session-create") {
      try {
        appSessionId = await claimSessionStartForUser(
          user,
          request.headers.get(APP_SESSION_HEADER),
        );
      } catch (error) {
        forbidden(error);
      }
    } else if (route.kind === "session") {
      try {
        await assertEveSessionAccess(user, route.sessionId, route.action);
        if (request.method === "POST" && /\/session\/[^/]+\/cancel\/?$/.test(new URL(request.url).pathname)) {
          await removeSandboxQueueEntry(route.sessionId, user.id);
        }
      } catch (error) {
        forbidden(error);
      }
    }

    return sessionAuthFor(user, loadConfig().appTestMode, appSessionId);
  };
}

export default eveChannel({
  auth: [studioAuth()],
  turnPolicy: "steer",
  // Предел читается при старте процесса eve, а не запекается при сборке:
  // без `.env` сборка получает значение по умолчанию.
  uploadPolicy: { maxBytes: readUploadMaxBytes() },
  fetchFile: fetchUserAttachment,
});
