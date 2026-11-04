/**
 * Файлы в ответе агента (#8): на завершении текстового блока сообщения
 * собирает ссылки на файлы песочницы и копирует их в S3.
 *
 * Хук выполняется в шаге-владельце и задерживает его до возврата, поэтому
 * копирование ждётся не дольше 30 секунд. Не успевший файл остаётся в
 * `copying` и доделывается в фоне того же процесса.
 */
import { defineHook } from "eve/hooks";
import { isEvalPrincipal } from "../lib/eval-auth";

import { loadConfig } from "@/lib/config";
import { HOOK_COPY_BUDGET_MS } from "@/lib/media/files";
import { messageIdOf } from "@/lib/media/message-id";
import { captureMessageFiles } from "@/lib/media/message-files";
import { parseSandboxLinks } from "@/lib/media/sandbox-path";
import { findAppSessionByEveId } from "@/lib/sessions/service";

interface MessageCompletedData {
  readonly message?: string;
  readonly stepIndex?: number;
  readonly turnId?: string;
}

/** Таймер бюджета; `unref` не держит процесс при завершении. */
function copyBudget(): { promise: Promise<void>; cancel: () => void } {
  let timer: NodeJS.Timeout;
  const promise = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, HOOK_COPY_BUDGET_MS);
    timer.unref();
  });
  return { promise, cancel: () => clearTimeout(timer) };
}

export default defineHook({
  events: {
    async "message.completed"(event, ctx) {
      // Копии агента (#12) показывает корневой агент в своём ответе.
      if (ctx.session.parent !== undefined) return;
      if (isEvalPrincipal(ctx.session.auth.initiator)) return;

      const data = event.data as MessageCompletedData;
      if (typeof data.message !== "string" || data.message.length === 0) return;
      const links = parseSandboxLinks(data.message);
      if (links.length === 0) return;
      const messageId = messageIdOf(data.turnId, data.stepIndex);
      if (messageId === undefined) {
        console.warn("[media] у message.completed нет координат сообщения", {
          eveSessionId: ctx.session.id,
        });
        return;
      }

      // Бюджет покрывает и поиск сессии, и копирование: хук целиком не
      // задерживает ход дольше HOOK_COPY_BUDGET_MS.
      const budget = copyBudget();
      try {
        const work = (async () => {
          const session = await findAppSessionByEveId(ctx.session.id);
          if (session === null) return;
          await captureMessageFiles({
            appSessionId: session.id,
            messageId,
            links,
            maxBytes: loadConfig().mediaCopyMaxBytes,
            userId: session.userId,
            getSandbox: () => ctx.getSandbox(),
          });
        })().catch((error: unknown) => {
          // Хук мог отпустить ход по бюджету: поздняя ошибка не должна
          // остаться необработанным отказом в процессе eve.
          console.error("[media] файлы сообщения не сохранены", {
            eveSessionId: ctx.session.id,
            messageId,
            error,
          });
        });

        const finishedInTime = await Promise.race([
          work.then(() => true),
          budget.promise.then(() => false),
        ]);
        if (!finishedInTime) {
          console.warn("[media] копирование не уложилось в бюджет", {
            eveSessionId: ctx.session.id,
            messageId,
            budgetMs: HOOK_COPY_BUDGET_MS,
          });
        }
      } finally {
        budget.cancel();
      }
    },
  },
});
