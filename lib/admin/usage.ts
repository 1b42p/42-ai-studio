import { loadConfig } from "@/lib/config";
import { getSqlClient } from "@/lib/db/client";
import { sessionIsBusyForAdmin } from "@/lib/sandbox/busy";
import { isUuid } from "@/lib/sessions/access";
import type { AdminResourceUser, AdminUsageResponse } from "./resource-types";
import { validUsageDate, validUsageDates } from "./usage-period";

const DAY_MS = 86_400_000;

export interface AdminUsageRequest {
  period: AdminUsageResponse["period"];
  userId: string | null;
}

type ParsedUsage =
  | { ok: true; request: AdminUsageRequest }
  | { ok: false; message: string };

/** Календарные даты, не прибавление 24 часов к местному timestamp (важно для DST). */
export function usageDates(from: string, to: string): string[] {
  const dates: string[] = [];
  for (let day = Date.parse(`${from}T00:00:00Z`); day <= Date.parse(`${to}T00:00:00Z`); day += DAY_MS) {
    dates.push(new Date(day).toISOString().slice(0, 10));
  }
  return dates;
}

export async function parseAdminUsageSearchParams(params: URLSearchParams): Promise<ParsedUsage> {
  const tz = params.get("tz") ?? "UTC";
  const sql = getSqlClient();
  // Проверка именно по базе: версии IANA в Node и Postgres могут различаться.
  const [zone] = await sql`select name from pg_timezone_names where name = ${tz} limit 1`;
  if (!zone) return { ok: false, message: "Укажите корректный часовой пояс" };
  const [clock] = await sql<{ today: string; week: string }[]>`
    select to_char(now() at time zone ${tz}, 'YYYY-MM-DD') as today,
      to_char((now() at time zone ${tz})::date - 6, 'YYYY-MM-DD') as week`;
  const from = params.get("from") ?? clock.week;
  const to = params.get("to") ?? clock.today;
  if (!validUsageDate(from) || !validUsageDate(to)) {
    return { ok: false, message: "Укажите даты в формате ГГГГ-ММ-ДД" };
  }
  if (!validUsageDates(from, to)) {
    return { ok: false, message: "Период должен содержать от 1 до 366 дней" };
  }
  const userId = params.get("userId");
  if (userId !== null && !isUuid(userId)) {
    return { ok: false, message: "Параметр userId некорректен" };
  }
  return { ok: true, request: { period: { from, to, tz }, userId } };
}

/** Открытая часть не входит в завершённый расход и ограничена периодом и автостопом. */
export function openSandboxSeconds(input: {
  runningSince: Date | null;
  lastActiveAt: Date;
  busy: boolean;
  idleMinutes: number;
  from: Date;
  until: Date;
  now: Date;
}): number {
  if (input.runningSince === null) return 0;
  const start = Math.max(input.runningSince.getTime(), input.from.getTime());
  const end = Math.min(
    input.now.getTime(),
    input.until.getTime(),
    input.busy ? Infinity : input.lastActiveAt.getTime() + input.idleMinutes * 60_000,
  );
  return Math.max(0, Math.round((end - start) / 1000));
}

interface AggregateRow {
  userId: string;
  name: string;
  username: string | null;
  date: string;
  sandboxSeconds: string;
  inputTokens: string;
  outputTokens: string;
}

interface OpenRow {
  appSessionId: string;
  userId: string;
  name: string;
  username: string | null;
  runningSince: string;
  lastActiveAt: string;
}

export async function getAdminUsage(request: AdminUsageRequest): Promise<AdminUsageResponse> {
  const { from, to, tz } = request.period;
  const now = new Date();
  // Один снимок не позволяет закрывшемуся между SELECT интервалу попасть
  // одновременно в завершённую и в открытую часть.
  const snapshot = await getSqlClient().begin("isolation level repeatable read read only", async (sql) => {
    // Drizzle устанавливает transparentParser у общего postgres.js-клиента:
    // raw SQL возвращает timestamp строкой, в отличие от типизированного select.
    const [bounds] = await sql<{ start: string; end: string }[]>`
      select ${from}::date::timestamp at time zone ${tz} as start,
        (${to}::date + 1)::timestamp at time zone ${tz} as end`;
    const rows = await sql<AggregateRow[]>`
      select u.id as "userId", u.name, u.username,
        to_char(r.recorded_at at time zone ${tz}, 'YYYY-MM-DD') as date,
        coalesce(sum(r.amount) filter (where r.kind = 'sandbox_seconds'), 0)::text as "sandboxSeconds",
        coalesce(sum(r.amount) filter (where r.kind = 'model_input_tokens'), 0)::text as "inputTokens",
        coalesce(sum(r.amount) filter (where r.kind = 'model_output_tokens'), 0)::text as "outputTokens"
      from (
        select user_id, kind, amount, recorded_at from usage_records
        union all
        select p.user_id, 'sandbox_seconds', p.amount, p.recorded_at
        from pending_sandbox_usage p where not exists (
          select 1 from usage_records delivered
          where delivered.kind = 'sandbox_seconds' and delivered.source_key = p.source_key
        )
      ) r join users u on u.id = r.user_id
      where r.recorded_at >= ${bounds.start} and r.recorded_at < ${bounds.end}
        and (${request.userId}::uuid is null or r.user_id = ${request.userId}::uuid)
      group by u.id, date`;
    const open = await sql<OpenRow[]>`
      select s.app_session_id as "appSessionId", u.id as "userId", u.name, u.username,
        s.running_since as "runningSince", s.last_active_at as "lastActiveAt"
      from sandboxes s join app_sessions a on a.id = s.app_session_id join users u on u.id = a.user_id
      where s.state = 'started' and s.running_since is not null and a.deleted_at is null
        and s.running_since < ${bounds.end}
        and (${request.userId}::uuid is null or u.id = ${request.userId}::uuid)`;
    return { bounds, rows, open };
  });

  const byDay = usageDates(from, to).map((date) => ({
    date, sandboxSeconds: 0, inputTokens: 0, outputTokens: 0,
  }));
  const days = new Map(byDay.map((day) => [day.date, day]));
  const byUser = new Map<string, AdminUsageResponse["byUser"][number]>();
  function userRow(user: AdminResourceUser) {
    let row = byUser.get(user.id);
    if (!row) {
      row = { user, sandboxSeconds: 0, openSandboxSeconds: 0, inputTokens: 0, outputTokens: 0 };
      byUser.set(user.id, row);
    }
    return row;
  }
  const totals = { sandboxSeconds: 0, inputTokens: 0, outputTokens: 0, openSandboxSeconds: 0 };
  for (const row of snapshot.rows) {
    const user = userRow({ id: row.userId, name: row.name, username: row.username });
    const day = days.get(row.date)!;
    for (const kind of ["sandboxSeconds", "inputTokens", "outputTokens"] as const) {
      const amount = Number(row[kind]);
      user[kind] += amount;
      day[kind] += amount;
      totals[kind] += amount;
    }
  }
  const idleMinutes = loadConfig().sandboxIdleStopMinutes;
  const openAmounts = await Promise.all(snapshot.open.map(async (row) => ({
    row,
    seconds: openSandboxSeconds({
      runningSince: new Date(row.runningSince),
      lastActiveAt: new Date(row.lastActiveAt),
      busy: await sessionIsBusyForAdmin(row.appSessionId, now.getTime()),
      idleMinutes,
      from: new Date(snapshot.bounds.start),
      until: new Date(snapshot.bounds.end),
      now,
    }),
  })));
  for (const { row, seconds } of openAmounts) {
    if (seconds === 0) continue;
    userRow({ id: row.userId, name: row.name, username: row.username }).openSandboxSeconds += seconds;
    totals.openSandboxSeconds += seconds;
  }
  const sorted = [...byUser.values()].sort((a, b) =>
    (b.sandboxSeconds + b.openSandboxSeconds) - (a.sandboxSeconds + a.openSandboxSeconds) ||
    a.user.id.localeCompare(b.user.id),
  );
  return {
    period: request.period, totals, byDay, byUser: sorted.slice(0, 100),
    othersCount: Math.max(0, sorted.length - 100),
  };
}
