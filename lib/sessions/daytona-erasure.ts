import type postgres from "postgres";

import { daytonaSandboxName, deleteDaytonaMachine } from "@/agent/lib/daytona-backend";
import { DELETED_KEY_MARKER } from "@/agent/lib/daytona-key-pool";
import { loadConfig } from "@/lib/config";
import { storedUsage } from "@/lib/daytona/usage";
import { cancellableQuery as query } from "@/lib/db/cancellable-query";
import { errorStatus, isMissingSandbox } from "@/lib/sandbox/errors";
import { DAYTONA_KEY_PURPOSE, decryptSecret } from "@/lib/secrets";

type Credential = { keyId: string; encrypted: string };
type Target = Credential & {
  sandboxId: string;
  usage: unknown;
  isCurrent: boolean;
  pendingDeletion: boolean;
};
type ErasureOptions = { deadline: number; signal: AbortSignal };

/** Удаляет только машины, атрибутированные этой сессии, без листинга Daytona. */
export async function deleteSessionDaytonaMachines(
  sql: postgres.ReservedSql,
  session: { id: string; eveSessionId: string | null },
  options: ErasureOptions,
): Promise<void> {
  const { signal } = options;
  const targets = await query(sql<Target[]>`
    select t.daytona_key_id as "keyId", t.daytona_sandbox_id as "sandboxId",
      k.api_key_encrypted as encrypted, k.usage,
      exists (select 1 from sandboxes s where s.app_session_id = t.app_session_id
        and s.daytona_key_id = t.daytona_key_id
        and s.daytona_sandbox_id = t.daytona_sandbox_id) as "isCurrent",
      exists (select 1 from pending_sandbox_deletions p where p.daytona_key_id = t.daytona_key_id
        and p.daytona_sandbox_id = t.daytona_sandbox_id) as "pendingDeletion"
    from sandbox_erasure_targets t join daytona_keys k on k.id = t.daytona_key_id
    where t.app_session_id = ${session.id}
    order by "isCurrent" desc, t.daytona_key_id, t.daytona_sandbox_id desc`, signal);

  const { secretsEncryptionKey } = loadConfig();
  async function erase(credential: Credential, identity: string): Promise<boolean> {
    if (credential.encrypted === DELETED_KEY_MARKER) return false;
    let secret: string;
    try {
      secret = decryptSecret(credential.encrypted, secretsEncryptionKey, DAYTONA_KEY_PURPOSE);
    } catch {
      return false;
    }
    try {
      await deleteDaytonaMachine(credential.keyId, secret, identity, {
        ...options, expectedSessionId: session.id,
      });
      return true;
    } catch (error) {
      signal.throwIfAborted();
      if (isMissingSandbox(error)) return true;
      const status = errorStatus(error);
      if (status === 401 || status === 403) return false;
      throw error;
    }
  }

  for (const target of targets) {
    const identity = target.sandboxId || (session.eveSessionId && daytonaSandboxName(session.eveSessionId));
    if (!identity) throw new Error("Sandbox identity missing");

    // Удаление ключа уже подтвердило очистку его текущей машины, иначе
    // маркер не был бы записан. Для исторической машины этого недостаточно.
    let erased = target.isCurrent && target.sandboxId !== "" && !target.pendingDeletion
      && target.encrypted === DELETED_KEY_MARKER;
    if (!erased) erased = await erase(target, identity);
    const organizationId = storedUsage(target.usage)?.organizationId;
    if (!erased && organizationId) {
      const alternatives = await query(sql<Credential[]>`
        select id as "keyId", api_key_encrypted as encrypted from daytona_keys
        where id <> ${target.keyId} and api_key_encrypted <> ${DELETED_KEY_MARKER}
          and usage -> 'organizationId' = to_jsonb(${organizationId}::text)
        order by enabled desc, created_at, id`, signal);
      for (const key of alternatives) {
        try {
          if (await erase(key, identity)) {
            erased = true;
            break;
          }
        } catch (error) {
          signal.throwIfAborted();
          const status = errorStatus(error);
          // Сбой запасного ключа не делает недоступной всю организацию.
          // Конфликт состояния или метки, в отличие от сбоя связи, не обходим.
          if (status !== undefined && status !== 429 && status < 500) throw error;
        }
      }
    }
    if (!erased) throw new Error("No usable credentials for attributed Daytona sandbox");

    if (target.sandboxId) await query(sql`delete from pending_sandbox_deletions
      where daytona_key_id = ${target.keyId} and daytona_sandbox_id = ${target.sandboxId}`, signal);
    await query(sql`delete from sandbox_erasure_targets where app_session_id = ${session.id}
      and daytona_key_id = ${target.keyId} and daytona_sandbox_id = ${target.sandboxId}`, signal);
  }
}
