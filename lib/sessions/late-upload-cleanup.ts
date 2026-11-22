import type postgres from "postgres";

import { cancellableQuery as query } from "@/lib/db/cancellable-query";
import { getSqlClient } from "@/lib/db/client";
import { getStorage } from "@/lib/s3";
import { UPLOAD_URL_TTL_SECONDS } from "@/lib/uploads/limits";

// PUT, принятый перед истечением подписи, может завершиться после него.
const SIGNATURE_GRACE_SECONDS = 60;
const TRANSFER_GRACE_SECONDS = 24 * 60 * 60;

/** Пишется в той же транзакции, которая каскадно удаляет квитанции загрузок. */
export async function enqueueLateUploadCleanup(
  tx: postgres.ReservedSql,
  session: { id: string; userId: string },
  signal: AbortSignal,
): Promise<void> {
  await query(tx`
    insert into late_upload_cleanups (id, user_id, next_attempt_at, final_sweep_at)
    select ${session.id}, ${session.userId},
      now() + make_interval(secs => ${UPLOAD_URL_TTL_SECONDS + SIGNATURE_GRACE_SECONDS}),
      now() + make_interval(secs => ${UPLOAD_URL_TTL_SECONDS + TRANSFER_GRACE_SECONDS})
    where exists (
      select 1 from media where app_session_id = ${session.id} and kind = 'upload'
    )
    on conflict (id) do nothing`, signal);
}

type Cleanup = {
  id: string;
  userId: string;
  lease: Date;
  finalSweepAt: Date;
  isFinal: boolean;
};

/** Захватывает дозревшую пачку; после сбоя процесса аренда истекает сама. */
export async function sweepLateUploads(): Promise<void> {
  const sql = getSqlClient();
  const signal = AbortSignal.timeout(25_000);
  const rows = await query(sql<Cleanup[]>`
    with due as (
      select id from late_upload_cleanups where next_attempt_at <= now()
      order by next_attempt_at, id limit 20 for update skip locked
    )
    update late_upload_cleanups cleanup
      set next_attempt_at = now() + interval '5 minutes'
    from due where cleanup.id = due.id
    returning cleanup.id, user_id as "userId", next_attempt_at as lease,
      final_sweep_at as "finalSweepAt", final_sweep_at <= now() as "isFinal"`, signal);

  const storage = getStorage();
  const results = await Promise.allSettled(rows.map(async (row) => {
    await storage.deletePrefix(`u/${row.userId}/s/${row.id}/uploads/`, { signal });
    if (row.isFinal) {
      await query(sql`delete from late_upload_cleanups
        where id = ${row.id} and next_attempt_at = ${row.lease}`, signal);
    } else {
      await query(sql`update late_upload_cleanups set next_attempt_at = ${row.finalSweepAt}
        where id = ${row.id} and next_attempt_at = ${row.lease}`, signal);
    }
  }));
  const failed = results.filter((result) => result.status === "rejected").length;
  if (failed) console.warn("[session:delete] late_upload_cleanup_incomplete", { failed });
}
