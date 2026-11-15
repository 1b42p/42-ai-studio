/** Проверка пользователя на сервере: страницы и обработчики маршрутов. */
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { cache } from "react";

import type { User } from "../db/schema";
import { errorResponse } from "../http/errors";
import { SESSION_COOKIE } from "./cookies";
import { safeNextPath } from "./next-path";
import { getUserFromRequest } from "./request";
import { getUserBySessionToken } from "./service";

/**
 * Пользователь текущего запроса из cookie страницы. `cache` схлопывает
 * обращение из layout и из страницы в один запрос к базе.
 */
export const getCurrentUser = cache(async (): Promise<User | null> => {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (token === undefined || token.length === 0) return null;
  return getUserBySessionToken(token);
});

/**
 * Страховка страниц: без входа — на `/login` с возвратом, заблокированному —
 * сообщение. Состояние берётся из базы на каждом запросе.
 */
export async function requireUser(nextPath: string): Promise<User> {
  const user = await getCurrentUser();
  if (user === null) {
    redirect(`/login?next=${encodeURIComponent(safeNextPath(nextPath))}`);
  }
  if (user.isBlocked) {
    redirect("/login?error=blocked");
  }
  return user;
}

/**
 * Страховка обработчиков маршрутов: `Response` — отказ, иначе пользователь.
 * Требуется вход: «Требуется вход»; заблокирован — «Доступ закрыт».
 */
export async function requireApiUser(request: Request): Promise<User | Response> {
  const user = await getUserFromRequest(request);
  if (user === null) return errorResponse(401, "unauthenticated", "Требуется вход");
  if (user.isBlocked) return errorResponse(403, "forbidden", "Доступ закрыт");
  return user;
}

/**
 * Страховка страниц `/admin`: кроме входа нужен флаг оператора из базы.
 * Не оператор видит обычную страницу 404 — существование админки не
 * раскрывается. Проверка стоит до вывода, поэтому статус ответа — 404.
 */
export async function requireOperator(nextPath: string): Promise<User> {
  const user = await requireUser(nextPath);
  if (!user.isOperator) notFound();
  return user;
}

/**
 * Страховка обработчиков `/api/admin/*`: без входа 401, заблокированному 403
 * «Доступ закрыт», вошедшему без флага — 403 «Нужны права оператора».
 */
export async function requireOperatorApi(request: Request): Promise<User | Response> {
  const user = await requireApiUser(request);
  if (user instanceof Response) return user;
  if (!user.isOperator) return errorResponse(403, "forbidden", "Нужны права оператора");
  return user;
}

/**
 * Проверка `Origin` для маршрутов, меняющих данные: чужой origin — 403.
 * Без заголовка запрос пропускается (клиенты без браузера).
 */
export function checkOrigin(request: Request, appUrl: string): Response | null {
  const origin = request.headers.get("origin");
  if (origin === null) return null;

  let requestOrigin: string;
  try {
    requestOrigin = new URL(origin).origin;
  } catch {
    return errorResponse(403, "forbidden", "Доступ закрыт");
  }
  if (requestOrigin === new URL(appUrl).origin) return null;
  return errorResponse(403, "forbidden", "Доступ закрыт");
}
