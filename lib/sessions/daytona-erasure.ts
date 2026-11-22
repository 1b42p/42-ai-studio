import type postgres from "postgres";

import { deleteDaytonaMachine, findDaytonaMachinesForSession } from "@/agent/lib/daytona-backend";
import { DELETED_KEY_MARKER } from "@/agent/lib/daytona-key-pool";
import { loadConfig } from "@/lib/config";
import { storedUsage } from "@/lib/daytona/usage";
import { cancellableQuery as query } from "@/lib/db/cancellable-query";
import { isMissingSandbox } from "@/lib/sandbox/errors";
import { DAYTONA_KEY_PURPOSE, decryptSecret } from "@/lib/secrets";

type Credential = { id: string; encrypted: string; usage: unknown };

/** Ищет машины, которые больше не представлены текущей строкой sandboxes. */
export async function deleteHistoricalDaytonaMachines(
  sql: postgres.ReservedSql,
  appSessionId: string,
  alreadyDeletedId: string | undefined,
  options: { deadline: number; signal: AbortSignal },
): Promise<void> {
  const keys = await query(sql<Credential[]>`
    select id, api_key_encrypted as encrypted, usage from daytona_keys
    where api_key_encrypted <> ${DELETED_KEY_MARKER}
    order by enabled desc, created_at, id`, options.signal);
  const organizations = new Map<string, Credential[]>();
  for (const key of keys) {
    const organizationId = storedUsage(key.usage)?.organizationId;
    const group = organizationId == null ? `key:${key.id}` : `org:${organizationId}`;
    organizations.set(group, [...(organizations.get(group) ?? []), key]);
  }

  const erased = new Set(alreadyDeletedId ? [alreadyDeletedId] : []);
  const config = loadConfig();
  let incomplete = false;
  for (const credentials of organizations.values()) {
    let found: { keyId: string; secret: string; ids: string[] } | undefined;
    for (const key of credentials) {
      options.signal.throwIfAborted();
      try {
        const secret = decryptSecret(key.encrypted, config.secretsEncryptionKey, DAYTONA_KEY_PURPOSE);
        const deadline = Math.min(options.deadline, Date.now() + 8_000);
        const signal = AbortSignal.any([
          options.signal, AbortSignal.timeout(Math.max(1, deadline - Date.now())),
        ]);
        const ids = await findDaytonaMachinesForSession(key.id, secret, appSessionId, { deadline, signal });
        found = { keyId: key.id, secret, ids };
        break;
      } catch {
        options.signal.throwIfAborted();
        // Другой ключ той же организации может дать доступ к её машинам.
      }
    }
    if (!found) {
      incomplete = true;
      continue;
    }
    for (const id of found.ids) {
      if (erased.has(id)) continue;
      try {
        await deleteDaytonaMachine(found.keyId, found.secret, id, { ...options, expectedSessionId: appSessionId });
      } catch (error) {
        options.signal.throwIfAborted();
        if (!isMissingSandbox(error)) {
          incomplete = true;
          continue;
        }
      }
      erased.add(id);
      await query(sql`delete from pending_sandbox_deletions
        where daytona_key_id = ${found.keyId} and daytona_sandbox_id = ${id}`, options.signal);
    }
  }
  if (incomplete) throw new Error("Daytona history cleanup incomplete");
}
