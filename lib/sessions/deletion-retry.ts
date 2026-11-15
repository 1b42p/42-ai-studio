import { after } from "next/server";
import { getSqlClient } from "@/lib/db/client";
import { deleteSessionData } from "./delete";

/** Вызывается общей функцией списка; не ждёт удаления и не требует cookie. */
export function scheduleSessionDeletionRetries(userId: string): void {
  after(async () => {
    try {
      const sql = getSqlClient();
      const claimed = await sql`insert into session_deletion_retries (user_id, attempted_at)
        values (${userId}, now()) on conflict (user_id) do update set attempted_at = now()
        where session_deletion_retries.attempted_at < now() - interval '1 minute'
        returning user_id`;
      if (!claimed.length) return;
      const sessions = await sql<{ id: string }[]>`select id from (
        select id, deleted_at as since from app_sessions
          where user_id = ${userId} and deleted_at < now() - interval '2 minutes'
        union all
        select id, created_at as since from session_deletions
          where user_id = ${userId} and created_at < now() - interval '2 minutes'
      ) pending group by id order by min(since), id limit 5`;
      await Promise.allSettled(sessions.map(({ id }) => deleteSessionData(id)));
    } catch {
      console.warn("[session:delete] retry_failed");
    }
  });
}
