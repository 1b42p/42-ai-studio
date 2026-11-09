import { defineHook, type HookContext, type HookEvent } from "eve/hooks";

import { isEvalPrincipal } from "../lib/eval-auth";
import { removeSandboxQueueEntry } from "@/lib/sandbox/queue-state";

async function releaseQueue(_event: HookEvent, ctx: HookContext): Promise<void> {
  if (isEvalPrincipal(ctx.session.auth.initiator) || ctx.session.parent !== undefined) return;
  await removeSandboxQueueEntry(ctx.session.id);
}

export default defineHook({
  events: {
    "turn.completed": releaseQueue,
    "turn.failed": releaseQueue,
    "turn.cancelled": releaseQueue,
    "session.waiting": releaseQueue,
    "session.failed": releaseQueue,
    "session.completed": releaseQueue,
  },
});
