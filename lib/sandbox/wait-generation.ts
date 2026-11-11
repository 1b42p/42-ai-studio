import { and, eq } from "drizzle-orm";

import { getDb, getSqlClient } from "@/lib/db/client";
import { appSessions, type AppSession } from "@/lib/db/schema";
import { StudioSandboxError } from "./errors";

export interface SandboxWait {
  readonly appSessionId: string;
  readonly generation: number;
}

export async function captureSandboxWait(
  session: Pick<AppSession, "id" | "sandboxWaitGeneration">,
  turnId: string,
): Promise<SandboxWait> {
  return getSqlClient().begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(20261110, 24)`;
    await tx`insert into sandbox_wait_turns (app_session_id, turn_id, generation)
      select id, ${turnId}, sandbox_wait_generation from app_sessions
      where id = ${session.id} and sandbox_wait_generation = ${session.sandboxWaitGeneration}
      on conflict (app_session_id, scope_id, turn_id) do nothing`;
    const [row] = await tx<{ generation: number }[]>`
      select w.generation from sandbox_wait_turns w join app_sessions a on a.id = w.app_session_id
      where w.app_session_id = ${session.id} and w.turn_id = ${turnId}
        and w.scope_id = 'root'
        and w.generation = a.sandbox_wait_generation`;
    if (!row) throw new StudioSandboxError("sandbox_wait_cancelled");
    return { appSessionId: session.id, generation: row.generation };
  });
}

export async function readSandboxCopyWait(
  session: Pick<AppSession, "id">,
  scopeId: string,
  turnId: string,
): Promise<SandboxWait> {
  const [row] = await getSqlClient()<{ generation: number }[]>`
    select w.generation from sandbox_wait_turns w join app_sessions a on a.id = w.app_session_id
    where w.app_session_id = ${session.id} and w.scope_id = ${scopeId} and w.turn_id = ${turnId}
      and w.generation = a.sandbox_wait_generation`;
  if (!row) throw new StudioSandboxError("sandbox_wait_cancelled");
  return { appSessionId: session.id, generation: row.generation };
}

export async function registerSandboxWaitTurn(eveSessionId: string, turnId: string): Promise<void> {
  const [session] = await getDb().select({ id: appSessions.id, sandboxWaitGeneration: appSessions.sandboxWaitGeneration })
    .from(appSessions).where(eq(appSessions.eveSessionId, eveSessionId));
  if (session) await captureSandboxWait(session, turnId);
}

export async function assertSandboxWait(wait: SandboxWait): Promise<void> {
  const [current] = await getDb().select({ id: appSessions.id }).from(appSessions).where(and(
    eq(appSessions.id, wait.appSessionId), eq(appSessions.sandboxWaitGeneration, wait.generation),
  ));
  if (!current) throw new StudioSandboxError("sandbox_wait_cancelled");
}

/** Короткий барьер непосредственно перед отправкой create/start/recover в Daytona. */
export async function beginSandboxLaunch(wait: SandboxWait): Promise<void> {
  await getSqlClient().begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(20261110, 24)`;
    const [row] = await tx`
      update sandboxes s set launch_started_at = now()
      from app_sessions a where s.app_session_id = ${wait.appSessionId} and a.id = s.app_session_id
        and a.sandbox_wait_generation = ${wait.generation} and s.wait_generation = ${wait.generation}
        and s.state = 'starting' returning s.id`;
    if (!row) throw new StudioSandboxError("sandbox_wait_cancelled");
  });
}
