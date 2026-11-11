import { getSqlClient } from "@/lib/db/client";
import { StudioSandboxError } from "./errors";
import type { SandboxWait } from "./wait-generation";

interface TaskCoordinates {
  readonly taskId: string;
  readonly callId: string;
  readonly turnId: string;
  readonly kind?: "agent" | "tool";
}

export async function recordSandboxTask(
  data: TaskCoordinates,
  rootEveSessionId: string,
  state: "active" | "settled",
): Promise<void> {
  await getSqlClient().begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(20261110, 24)`;
    if (state === "settled") {
      await tx`update sandbox_task_calls c set state = 'settled' from app_sessions a
        where c.app_session_id = a.id and a.eve_session_id = ${rootEveSessionId} and c.call_id = ${data.callId}`;
      return;
    }
    const [call] = await tx`
      insert into sandbox_task_calls (app_session_id, task_id, call_id, turn_id, generation, kind)
      select a.id, ${data.taskId}, ${data.callId}, ${data.turnId}, w.generation, ${data.kind ?? "tool"}
      from app_sessions a join sandbox_wait_turns w on w.app_session_id = a.id
      where a.eve_session_id = ${rootEveSessionId} and w.scope_id = 'root' and w.turn_id = ${data.turnId}
        and w.generation = a.sandbox_wait_generation
      on conflict (app_session_id, call_id) do nothing returning id`;
    // Повтор уже записанного события не меняет поколение или settled.
    if (!call) {
      const [known] = await tx`select c.id from sandbox_task_calls c join app_sessions a on a.id = c.app_session_id
        where a.eve_session_id = ${rootEveSessionId} and c.call_id = ${data.callId}`;
      if (!known) throw new StudioSandboxError("sandbox_wait_cancelled");
    }
  });
}

export async function captureSandboxCopyWait(
  rootEveSessionId: string,
  parentCallId: string,
  childTurnId: string,
): Promise<SandboxWait> {
  return getSqlClient().begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(20261110, 24)`;
    const [call] = await tx<{ appSessionId: string; generation: number }[]>`
      select c.app_session_id as "appSessionId", c.generation from sandbox_task_calls c
      join app_sessions a on a.id = c.app_session_id
      where a.eve_session_id = ${rootEveSessionId} and c.task_id = (
        select initial.task_id from sandbox_task_calls initial
        where initial.app_session_id = a.id and initial.call_id = ${parentCallId})
        and c.state = 'active' and c.kind = 'agent' and c.generation = a.sandbox_wait_generation
      order by c.created_at desc, c.id desc limit 1`;
    if (!call) throw new StudioSandboxError("sandbox_wait_cancelled");
    await tx`insert into sandbox_wait_turns (app_session_id, scope_id, turn_id, generation)
      values (${call.appSessionId}, ${parentCallId}, ${childTurnId}, ${call.generation})
      on conflict (app_session_id, scope_id, turn_id) do nothing`;
    const [turn] = await tx<{ generation: number }[]>`
      select generation from sandbox_wait_turns where app_session_id = ${call.appSessionId}
        and scope_id = ${parentCallId} and turn_id = ${childTurnId}`;
    if (turn.generation !== call.generation) throw new StudioSandboxError("sandbox_wait_cancelled");
    return { appSessionId: call.appSessionId, generation: turn.generation };
  });
}
