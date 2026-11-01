/**
 * Канал eve: единственный аутентификатор — наша серверная сессия входа.
 * `localDev()`, `vercelOidc()` и `placeholderAuth()` не подключаются: иначе
 * тесты доступа ничего бы не доказывали.
 *
 * Вторая ступень проверяет принадлежность сессии eve: на создании — по
 * заголовку `x-studio-session-id`, на остальных маршрутах — по привязке
 * идентификатора сессии eve к сессии приложения этого пользователя.
 */
import { ForbiddenError, type AuthFn, type AuthResult } from "eve/channels/auth";
import { eveChannel } from "eve/channels/eve";

import { getUserFromRequest } from "@/lib/auth/request";
import { loadConfig } from "@/lib/config";
import type { User } from "@/lib/db/schema";
import {
  APP_SESSION_HEADER,
  assertEveSessionAccess,
  claimSessionStartForUser,
  parseEveRoute,
  SessionAccessError,
} from "@/lib/sessions/access";

const INFO_ROUTE_PATH = "/eve/v1/info";

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
        await assertEveSessionAccess(user, route.sessionId);
      } catch (error) {
        forbidden(error);
      }
    }

    return sessionAuthFor(user, loadConfig().appTestMode, appSessionId);
  };
}

export default eveChannel({ auth: [studioAuth()], turnPolicy: "steer" });
