import { defineHook, type HookContext } from "eve/hooks";

import { loadConfig } from "@/lib/config";
import { messageIdOf } from "@/lib/media/message-id";
import { captureMessageFiles } from "@/lib/media/message-files";
import { parseSandboxLinks, type SandboxLink } from "@/lib/media/sandbox-path";
import { findAppSessionByEveId } from "@/lib/sessions/service";

import { isEvalPrincipal } from "../lib/eval-auth";

async function publish(
  ctx: HookContext,
  data: { turnId?: string; stepIndex?: number },
  links: readonly SandboxLink[],
) {
  // Корень публикует медиа из общей песочницы; eval не пишет в базу.
  if (ctx.session.parent !== undefined || isEvalPrincipal(ctx.session.auth.initiator)) return;
  const messageId = messageIdOf(data.turnId, data.stepIndex);
  if (messageId === undefined) return;
  const session = await findAppSessionByEveId(ctx.session.id);
  if (session === null) return;
  await captureMessageFiles({
    appSessionId: session.id,
    userId: session.userId,
    messageId,
    links,
    maxBytes: loadConfig().mediaCopyMaxBytes,
    getSandbox: () => ctx.getSandbox(),
  });
}

export default defineHook({
  events: {
    async "message.completed"(event, ctx) {
      const links = parseSandboxLinks(event.data.message ?? "");
      if (links.length > 0) {
        // Хук остаётся частью шага Eve до завершения публикации. Если процесс
        // упадёт, Eve повторит шаг; фонового промиса вне checkpoint нет.
        await publish(ctx, event.data, links);
      }
    },
    async "*"(event, ctx) {
      if (event.type === "step.started") {
        // Wildcard идёт после типизированного хука защиты песочницы.
        // Сначала публикуем старые ссылки этого шага, затем повторяем модель:
        // её новый ответ может не содержать ссылку или перезаписать файл.
        await publish(ctx, event.data, []);
      }
    },
  },
});
