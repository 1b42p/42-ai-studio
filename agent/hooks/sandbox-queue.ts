import { defineHook, type HookContext, type HookEvent } from "eve/hooks";

import { isEvalPrincipal } from "../lib/eval-auth";
import { removeSandboxQueueEntry } from "@/lib/sandbox/queue-state";
import { recordSandboxWork } from "@/lib/sandbox/maintenance";

function eventTurnId(event: HookEvent): string | undefined {
  const data = event.data ?? {};
  return "turnId" in data && typeof data.turnId === "string" ? data.turnId : undefined;
}

async function releaseQueue(_event: HookEvent, ctx: HookContext): Promise<void> {
  if (isEvalPrincipal(ctx.session.auth.initiator) || ctx.session.parent !== undefined) return;
  try {
    await recordSandboxWork(ctx.session.id, "idle", eventTurnId(_event), _event.meta.id);
  } catch {
    // Терминальное событие в сохранённом потоке также освобождает занятость.
    console.warn("[sandbox:queue] work_release_failed");
  }
  await removeSandboxQueueEntry(ctx.session.id);
}

async function beginWork(event: HookEvent, ctx: HookContext): Promise<void> {
  if (isEvalPrincipal(ctx.session.auth.initiator) || ctx.session.parent !== undefined) return;
  try {
    await recordSandboxWork(ctx.session.id, "active", eventTurnId(event), event.meta.id);
  } catch {
    console.warn("[sandbox:queue] work_barrier_failed");
    ctx.cancel();
  }
}

async function waitForInput(event: HookEvent, ctx: HookContext): Promise<void> {
  const data = event.data ?? {};
  if (!("on" in data) || data.on !== "input" ||
      isEvalPrincipal(ctx.session.auth.initiator) || ctx.session.parent !== undefined) return;
  await recordSandboxWork(ctx.session.id, "input", eventTurnId(event), event.meta.id);
}

export default defineHook({
  events: {
    "turn.started": beginWork,
    "step.started": beginWork,
    "input.resolved": beginWork,
    "turn.waiting": waitForInput,
    "turn.completed": releaseQueue,
    "turn.failed": releaseQueue,
    "turn.cancelled": releaseQueue,
    "session.waiting": releaseQueue,
    "session.failed": releaseQueue,
    "session.completed": releaseQueue,
  },
});
