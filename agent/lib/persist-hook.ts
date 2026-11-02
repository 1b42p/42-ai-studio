/**
 * Обработчик хука сохранения событий, отделённый от `defineHook`, чтобы
 * проверять его тестом с искусственно задержанной синхронизацией.
 *
 * Правила из тикета #5:
 * - на приращениях синхронизация запрашивается без ожидания — хук не должен
 *   замедлять поток;
 * - на границах хук ждёт, пока событие окажется в базе;
 * - `session.started` сначала привязывает сессию eve к сессии приложения;
 * - `turn.started` отменяет ход, если сессия eve не привязана к сессии
 *   приложения её инициатора;
 * - дочерние сессии пропускаются: ими займётся #12.
 */
import type { HookContext, HookEvent, StreamEventHook } from "eve/hooks";

import {
  BOUNDARY_EVENTS,
  INCREMENTAL_EVENTS,
  requestSessionSync,
  syncAndConfirm,
} from "@/lib/sessions/events";
import { bindAppSession, findAppSessionByEveId } from "@/lib/sessions/service";

/** Сессия приложения, найденная по идентификатору сессии eve. */
export interface BoundAppSession {
  readonly id: string;
  readonly userId: string;
}

/** Всё, что обработчику нужно от базы и синхронизации. */
export interface PersistDependencies {
  readonly findSessionByEveId: (eveSessionId: string) => Promise<BoundAppSession | null>;
  readonly bindSession: (input: {
    appSessionId: string;
    userId: string;
    eveSessionId: string;
  }) => Promise<boolean>;
  readonly requestSync: (appSessionId: string) => Promise<unknown>;
  readonly syncAndConfirm: (appSessionId: string, eventId: string | null) => Promise<boolean>;
}

export const defaultPersistDependencies: PersistDependencies = {
  findSessionByEveId: async (eveSessionId) => {
    const session = await findAppSessionByEveId(eveSessionId);
    return session === null ? null : { id: session.id, userId: session.userId };
  },
  bindSession: ({ appSessionId, userId, eveSessionId }) =>
    bindAppSession(appSessionId, userId, eveSessionId),
  requestSync: (appSessionId) => requestSessionSync(appSessionId),
  syncAndConfirm: (appSessionId, eventId) => syncAndConfirm(appSessionId, eventId),
};

function logSyncFailure(error: unknown): void {
  console.error("[sessions] синхронизация событий не удалась:", error);
}

/**
 * Сессия приложения, привязанная к этой сессии eve и принадлежащая её
 * инициатору. `session.started` и `turn.started` приходят независимо и могут
 * обгонять друг друга, поэтому привязка идемпотентна: если сессии eve ещё нет
 * в базе, пробуем привязать её к сессии приложения из данных инициатора.
 */
async function resolveInitiatorSession(
  ctx: HookContext,
  deps: PersistDependencies,
): Promise<BoundAppSession | null> {
  const initiator = ctx.session.auth.initiator;
  if (initiator === null || initiator === undefined) return null;

  const existing = await deps.findSessionByEveId(ctx.session.id);
  if (existing !== null) {
    return existing.userId === initiator.principalId ? existing : null;
  }

  const appSessionId = initiator.attributes.appSessionId;
  if (typeof appSessionId !== "string") return null;

  const bound = await deps.bindSession({
    appSessionId,
    userId: initiator.principalId,
    eveSessionId: ctx.session.id,
  });
  if (!bound) {
    // Повтор session.started или уже стоящая привязка к этой же сессии — не ошибка.
    const current = await deps.findSessionByEveId(ctx.session.id);
    if (current === null) {
      console.warn("[sessions] сессия приложения уже занята другой сессией eve", {
        appSessionId,
        eveSessionId: ctx.session.id,
      });
    }
  }

  const session = await deps.findSessionByEveId(ctx.session.id);
  return session !== null && session.userId === initiator.principalId ? session : null;
}

export function createPersistEventHandler(
  deps: PersistDependencies = defaultPersistDependencies,
): StreamEventHook<HookEvent> {
  return async (event, ctx) => {
    if (ctx.session.parent !== undefined) return;

    try {
      let appSession: BoundAppSession | null | undefined;

      if (event.type === "session.started") {
        appSession = await resolveInitiatorSession(ctx, deps);
        if (appSession === null) {
          console.warn("[sessions] сессию eve не к чему привязать", {
            eveSessionId: ctx.session.id,
          });
          return;
        }
        const confirmed = await deps.syncAndConfirm(appSession.id, event.meta?.id ?? null);
        if (!confirmed) {
          console.warn("[sessions] событие session.started не появилось в базе", {
            eveSessionId: ctx.session.id,
          });
        }
        return;
      }

      if (event.type === "turn.started") {
        appSession = await resolveInitiatorSession(ctx, deps);
        if (appSession === null) {
          console.warn("[sessions] ход отменён: сессия eve не привязана к сессии приложения", {
            eveSessionId: ctx.session.id,
          });
          ctx.cancel();
          return;
        }
      }

      appSession ??= await deps.findSessionByEveId(ctx.session.id);
      if (appSession === null) return;

      if (INCREMENTAL_EVENTS.has(event.type)) {
        void deps.requestSync(appSession.id).catch(logSyncFailure);
        return;
      }

      if (BOUNDARY_EVENTS.has(event.type)) {
        const confirmed = await deps.syncAndConfirm(appSession.id, event.meta?.id ?? null);
        if (!confirmed) {
          console.warn("[sessions] событие не появилось в базе после повторов", {
            eveSessionId: ctx.session.id,
            eventId: event.meta?.id,
            type: event.type,
          });
        }
        return;
      }

      void deps.requestSync(appSession.id).catch(logSyncFailure);
    } catch (error) {
      // Ошибка записи не должна ронять ход: следующая синхронизация нагонит.
      console.error("[sessions] не удалось сохранить событие", {
        eveSessionId: ctx.session.id,
        type: event.type,
        error,
      });
    }
  };
}
