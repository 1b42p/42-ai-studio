/**
 * Сессии копий агента (#12).
 *
 * Встроенный инструмент `agent` открывает дочернюю сессию eve и объявляет её
 * событием `agent.started` в потоке корня. eve не проверяет владельца потока
 * (`guides/auth-and-route-protection.md`), поэтому строку `agent_sessions`
 * пишет синхронизатор событий, а канал по ней проверяет доступ.
 */
import type { MessageStreamEvent } from "eve/client";
import { and, eq, gt, isNotNull, sql } from "drizzle-orm";

import { getDb } from "../db/client";
import { agentSessions, appSessions, sessionEvents } from "../db/schema";
import { sleep } from "../sleep";

/** Строка `agent_sessions`, которую создаёт событие `agent.started`. */
export interface CopySessionRow {
  readonly appSessionId: string;
  readonly eveSessionId: string;
  readonly taskId: string | null;
  readonly callId: string;
  readonly name: string;
}

/** Копия, найденная по идентификатору сессии eve, с владельцем. */
export interface CopySessionBinding {
  readonly id: string;
  readonly appSessionId: string;
  readonly userId: string;
}

/**
 * Строка таблицы из события потока корня. `null` — событие не открывает
 * сессию копии. `taskId` у `agent.started` бывает пустым: так eve объявляет
 * сессию, открытую вызовом без задачи.
 */
export function copySessionFromEvent(
  event: MessageStreamEvent,
  appSessionId: string,
): CopySessionRow | null {
  if (event.type !== "agent.started") return null;

  const data = event.data;
  if (typeof data.sessionId !== "string" || data.sessionId.length === 0) return null;

  return {
    appSessionId,
    eveSessionId: data.sessionId,
    taskId: data.taskId ?? null,
    callId: data.callId,
    name: data.name,
  };
}

/** Копия по идентификатору сессии eve; `null` — такой строки ещё нет. */
export async function findAgentSessionByEveId(
  eveSessionId: string,
): Promise<CopySessionBinding | null> {
  const [row] = await getDb()
    .select({
      id: agentSessions.id,
      appSessionId: agentSessions.appSessionId,
      userId: appSessions.userId,
    })
    .from(agentSessions)
    .innerJoin(appSessions, eq(agentSessions.appSessionId, appSessions.id))
    .where(eq(agentSessions.eveSessionId, eveSessionId))
    .limit(1);
  return row ?? null;
}

/**
 * Ждёт строку `agent_sessions` до `timeoutMs`, опрашивая раз в `pollMs`.
 * Событие попадает в поток раньше записи в базу, поэтому браузер может
 * открыть поток копии первым.
 */
export async function waitForAgentSession(
  eveSessionId: string,
  options: { timeoutMs: number; pollMs: number },
): Promise<CopySessionBinding | null> {
  const deadline = Date.now() + options.timeoutMs;
  for (;;) {
    const found = await findAgentSessionByEveId(eveSessionId);
    if (found !== null) return found;
    if (Date.now() + options.pollMs > deadline) return null;
    await sleep(options.pollMs);
  }
}

/**
 * Была ли у пользователя активность за последние `windowMs`: сессия приложения
 * с привязанной сессией eve и сохранёнными событиями. По ней канал понимает,
 * что неизвестный идентификатор может быть только что открытой копией.
 */
export async function hasRecentSessionActivity(
  userId: string,
  windowMs: number,
): Promise<boolean> {
  const [row] = await getDb()
    .select({ id: sessionEvents.id })
    .from(sessionEvents)
    .innerJoin(appSessions, eq(sessionEvents.appSessionId, appSessions.id))
    .where(
      and(
        eq(appSessions.userId, userId),
        isNotNull(appSessions.eveSessionId),
        gt(
          sessionEvents.createdAt,
          sql`now() - make_interval(secs => ${Math.max(1, Math.round(windowMs / 1000))})`,
        ),
      ),
    )
    .limit(1);
  return row !== undefined;
}
