import { expect, test } from "vitest";
import { getSqlClient } from "../../lib/db/client";

/** Только согласованные доменные исключения, каждое с объяснением. */
const CASCADE_EXCEPTIONS: Readonly<Record<string, string>> = {
  "usage_records.app_session_id": "Расход остаётся после удаления сессии.",
  "pending_sandbox_usage.app_session_id": "Квитанция расхода остаётся после удаления сессии.",
  "late_upload_cleanups.user_id": "Область S3 переживает удаление пользователя до окончания отложенной очистки.",
};

test("каждая колонка app_session_id/user_id имеет правильный ON DELETE CASCADE", async () => {
  const columns = await getSqlClient()<{ table_name: string; column_name: string; cascade: boolean }[]>`
    select c.table_name, c.column_name, exists (
      select 1 from information_schema.key_column_usage k
      join information_schema.referential_constraints r
        on r.constraint_schema = k.constraint_schema and r.constraint_name = k.constraint_name
      join information_schema.key_column_usage target
        on target.constraint_schema = r.unique_constraint_schema
          and target.constraint_name = r.unique_constraint_name
          and target.ordinal_position = k.position_in_unique_constraint
      where k.table_schema = c.table_schema and k.table_name = c.table_name
        and k.column_name = c.column_name and r.delete_rule = 'CASCADE'
        and target.table_schema = 'public' and target.column_name = 'id'
        and target.table_name = case c.column_name
          when 'app_session_id' then 'app_sessions' else 'users' end
    ) as cascade
    from information_schema.columns c
    where c.table_schema = 'public' and c.column_name in ('app_session_id', 'user_id')
    order by c.table_name, c.column_name`;
  expect(columns.length).toBeGreaterThan(0);
  for (const column of columns) {
    const key = `${column.table_name}.${column.column_name}`;
    if (key in CASCADE_EXCEPTIONS) {
      expect(CASCADE_EXCEPTIONS[key].trim(), `Причина исключения ${key}`).not.toBe("");
    } else {
      expect(column.cascade, `${key}: нужен FK с ON DELETE CASCADE`).toBe(true);
    }
  }
  for (const exception of Object.keys(CASCADE_EXCEPTIONS)) {
    expect(columns.some((column) => `${column.table_name}.${column.column_name}` === exception), exception).toBe(true);
  }
});
