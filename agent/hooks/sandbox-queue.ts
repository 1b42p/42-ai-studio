import { defineHook, type HookContext, type HookEvent } from "eve/hooks";

import { isEvalPrincipal } from "../lib/eval-auth";
import { removeSandboxQueueEntry } from "@/lib/sandbox/queue-state";
import { recordSandboxWork } from "@/lib/sandbox/maintenance";
import { recordSandboxCopyWork } from "@/lib/sandbox/copy-work";
import { registerSandboxWaitTurn } from "@/lib/sandbox/wait-generation";
import { captureSandboxCopyWait, recordSandboxTask } from "@/lib/sandbox/task-waits";

function eventTurnId(event: HookEvent): string | undefined {
  const data = event.data ?? {};
  return "turnId" in data && typeof data.turnId === "string" ? data.turnId : undefined;
}

async function releaseQueue(event: HookEvent, ctx: HookContext): Promise<void> {
  if (isEvalPrincipal(ctx.session.auth.initiator)) return;
  try {
    await recordWork(event, ctx, "idle");
  } catch {
    // У копии следующая граница session.* повторяет освобождение;
    // для корня доступна также сверка с сохранённым потоком.
    console.warn("[sandbox:queue] work_release_failed");
  }
  if (ctx.session.parent === undefined) {
    await removeSandboxQueueEntry(
      ctx.session.id, undefined, eventTurnId(event) ?? ctx.session.turn.id,
    );
  }
}

async function recordWork(
  event: HookEvent,
  ctx: HookContext,
  state: "active" | "input" | "idle",
): Promise<void> {
  if (ctx.session.parent !== undefined) {
    const data = event.data ?? {};
    const sequence = "sequence" in data &&
      typeof data.sequence === "number" ? data.sequence : ctx.session.turn.sequence;
    await recordSandboxCopyWork(
      ctx.session.parent.rootSessionId, ctx.session.id, state,
      eventTurnId(event) ?? ctx.session.turn.id, event.meta.id, sequence,
    );
    return;
  }
  await recordSandboxWork(ctx.session.id, state, eventTurnId(event), event.meta.id);
}

async function beginWork(event: HookEvent, ctx: HookContext): Promise<void> {
  if (isEvalPrincipal(ctx.session.auth.initiator)) return;
  try {
    if (event.type === "turn.started") {
      const turnId = eventTurnId(event) ?? ctx.session.turn.id;
      if (ctx.session.parent === undefined) {
        await registerSandboxWaitTurn(ctx.session.id, turnId);
      } else {
        await captureSandboxCopyWait(
          ctx.session.parent.rootSessionId, ctx.session.parent.callId, turnId,
        );
      }
    }
    await recordWork(event, ctx, "active");
  } catch {
    console.warn("[sandbox:queue] work_barrier_failed");
    ctx.cancel();
  }
}

async function recordTask(
  event: HookEvent<"task.started" | "task.settled">,
  ctx: HookContext,
): Promise<void> {
  if (ctx.session.parent !== undefined || isEvalPrincipal(ctx.session.auth.initiator)) return;
  try {
    await recordSandboxTask(event.data, ctx.session.id, event.type === "task.started" ? "active" : "settled");
  } catch {
    // ctx.cancel() на task.* не действует. Копия без сохранённого поколения
    // будет остановлена своим turn.started до model/tool.
    console.warn("[sandbox:queue] task_binding_failed");
  }
}

async function waitForInput(event: HookEvent, ctx: HookContext): Promise<void> {
  const data = event.data ?? {};
  if (!("on" in data) || data.on !== "input" ||
      isEvalPrincipal(ctx.session.auth.initiator)) return;
  await recordWork(event, ctx, "input");
}

export default defineHook({
  events: {
    "turn.started": beginWork,
    "step.started": beginWork,
    "input.resolved": beginWork,
    "task.started": recordTask,
    "task.settled": recordTask,
    "turn.waiting": waitForInput,
    "turn.completed": releaseQueue,
    "turn.failed": releaseQueue,
    "turn.cancelled": releaseQueue,
    "session.waiting": releaseQueue,
    "session.failed": releaseQueue,
    "session.completed": releaseQueue,
  },
});
