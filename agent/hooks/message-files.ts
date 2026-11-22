import { defineHook, type HookContext } from "eve/hooks";

import { loadConfig } from "@/lib/config";
import { messageIdOf } from "@/lib/media/message-id";
import { captureMessageFiles, completedMessageFiles, pendingMessageIdsForStep } from "@/lib/media/message-files";
import type { SandboxLink } from "@/lib/media/sandbox-path";
import { findAppSessionByEveId } from "@/lib/sessions/service";

import { isEvalPrincipal } from "../lib/eval-auth";

async function publish(
  ctx: HookContext,
  target: { messageId: string; links: readonly SandboxLink[] } | { stepId: string },
) {
  // Корень публикует медиа из общей песочницы; eval не пишет в базу.
  if (ctx.session.parent !== undefined || isEvalPrincipal(ctx.session.auth.initiator)) return;
  const session = await findAppSessionByEveId(ctx.session.id);
  if (session === null) return;
  const pending = "stepId" in target
    ? (await pendingMessageIdsForStep(session.id, target.stepId)).map((messageId) => ({ messageId, links: [] }))
    : [target];
  for (const publication of pending) {
    await captureMessageFiles({
      appSessionId: session.id,
      userId: session.userId,
      ...publication,
      maxBytes: loadConfig().mediaCopyMaxBytes,
      getSandbox: () => ctx.getSandbox(),
    });
  }
}

export default defineHook({
  events: {
    async "message.completed"(event, ctx) {
      const publication = completedMessageFiles(event.data);
      if (publication) {
        // Хук остаётся частью шага Eve до завершения публикации. Если процесс
        // упадёт, Eve повторит шаг; фонового промиса вне checkpoint нет.
        await publish(ctx, publication);
      }
    },
    async "*"(event, ctx) {
      if (event.type === "step.started") {
        // Wildcard идёт после типизированного хука защиты песочницы.
        // Сначала публикуем старые ссылки этого шага, затем повторяем модель:
        // её новый ответ может не содержать ссылку или перезаписать файл.
        const stepId = messageIdOf(event.data.turnId, event.data.stepIndex);
        if (stepId !== undefined) await publish(ctx, { stepId });
      }
    },
  },
});
