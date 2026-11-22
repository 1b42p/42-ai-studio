import { sql } from "drizzle-orm";

import { loadConfig } from "@/lib/config";
import { getDb, getSqlClient } from "@/lib/db/client";
import { sessionIsBusyForAdmin } from "@/lib/sandbox/busy";
import { isUuid } from "@/lib/sessions/access";
import type { AdminUsageResponse } from "./resource-types";
import { validUsageDate, validUsageDates } from "./usage-period";

const DAY_MS = 86_400_000;

export interface AdminUsageRequest {
  period: AdminUsageResponse["period"];
  userId: string | null;
  q: string;
  metric: "sandboxes" | "tokens";
  page: number;
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
  const q = (params.get("q") ?? "").trim().replace(/^@/, "").toLowerCase();
  const metric = params.get("metric") ?? "sandboxes";
  const page = params.get("page") ?? "1";
  if (q.length > 64) return { ok: false, message: "Поиск должен быть не длиннее 64 символов" };
  if (metric !== "sandboxes" && metric !== "tokens") {
    return { ok: false, message: "Укажите корректный показатель" };
  }
  if (!/^[1-9]\d{0,8}$/.test(page)) {
    return { ok: false, message: "Укажите корректную страницу" };
  }
  return { ok: true, request: { period: { from, to, tz }, userId, q, metric, page: Number(page) } };
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

type AggregateRow = {
  date: string;
  sandboxSeconds: string;
  inputTokens: string;
  outputTokens: string;
};

type OpenRow = {
  appSessionId: string;
  userId: string;
  runningSince: string;
  lastActiveAt: string;
};

export async function getAdminUsage(request: AdminUsageRequest): Promise<AdminUsageResponse> {
  const { from, to, tz } = request.period;
  const now = new Date();
  // Один снимок не позволяет закрывшемуся между SELECT интервалу попасть
  // одновременно в завершённую и в открытую часть.
  return getDb().transaction(async (tx) => {
    // Drizzle устанавливает transparentParser у общего postgres.js-клиента:
    // raw SQL возвращает timestamp строкой, в отличие от типизированного select.
    const [bounds] = await tx.execute<{ start: string; end: string }>(sql`
      select ${from}::date::timestamp at time zone ${tz} as start,
        (${to}::date + 1)::timestamp at time zone ${tz} as end`);
    const records = sql`
      with records as (
        select user_id, kind, amount, recorded_at from usage_records
        union all
        select p.user_id, 'sandbox_seconds', p.amount, p.recorded_at
        from pending_sandbox_usage p where not exists (
          select 1 from usage_records delivered
          where delivered.kind = 'sandbox_seconds' and delivered.source_key = p.source_key
        )
      ), period_records as (
        select * from records
        where recorded_at >= ${bounds.start}::timestamptz and recorded_at < ${bounds.end}::timestamptz
          and (${request.userId}::uuid is null or user_id = ${request.userId}::uuid)
      )`;
    // Только агрегаты по дням, а не весь набор «пользователь × день».
    const rows = await tx.execute<AggregateRow>(sql`
      ${records}
      select to_char(recorded_at at time zone ${tz}, 'YYYY-MM-DD') as date,
        coalesce(sum(amount) filter (where kind = 'sandbox_seconds'), 0)::text as "sandboxSeconds",
        coalesce(sum(amount) filter (where kind = 'model_input_tokens'), 0)::text as "inputTokens",
        coalesce(sum(amount) filter (where kind = 'model_output_tokens'), 0)::text as "outputTokens"
      from period_records group by date`);
    const open = await tx.execute<OpenRow>(sql`
      select a.id as "appSessionId", a.user_id as "userId",
        s.running_since as "runningSince", s.last_active_at as "lastActiveAt"
      from sandboxes s join app_sessions a on a.id = s.app_session_id
      where s.state = 'started' and s.running_since is not null and a.deleted_at is null
        and s.running_since < ${bounds.end}::timestamptz
        and (${request.userId}::uuid is null or a.user_id = ${request.userId}::uuid)`);
    const byDay = usageDates(from, to).map((date) => ({
      date, sandboxSeconds: 0, inputTokens: 0, outputTokens: 0,
    }));
    const days = new Map(byDay.map((day) => [day.date, day]));
    const totals = { sandboxSeconds: 0, inputTokens: 0, outputTokens: 0, openSandboxSeconds: 0 };
    for (const row of rows) {
      const day = days.get(row.date)!;
      for (const kind of ["sandboxSeconds", "inputTokens", "outputTokens"] as const) {
        day[kind] = Number(row[kind]);
        totals[kind] += day[kind];
      }
    }
    const idleMinutes = loadConfig().sandboxIdleStopMinutes;
    const openAmounts = (await Promise.all(open.map(async (row) => ({
      userId: row.userId,
      seconds: openSandboxSeconds({
        runningSince: new Date(row.runningSince),
        lastActiveAt: new Date(row.lastActiveAt),
        busy: await sessionIsBusyForAdmin(row.appSessionId, now.getTime(), tx),
        idleMinutes, from: new Date(bounds.start), until: new Date(bounds.end), now,
      }),
    })))).filter((row) => row.seconds > 0);
    totals.openSandboxSeconds = openAmounts.reduce((sum, row) => sum + row.seconds, 0);

    const users = sql`
      ${records}, amounts as (
        select user_id,
          coalesce(sum(amount) filter (where kind = 'sandbox_seconds'), 0) as sandbox,
          coalesce(sum(amount) filter (where kind = 'model_input_tokens'), 0) as input,
          coalesce(sum(amount) filter (where kind = 'model_output_tokens'), 0) as output,
          0::numeric as open
        from period_records group by user_id
        union all
        select (value->>'userId')::uuid, 0, 0, 0, (value->>'seconds')::numeric
        from jsonb_array_elements(${JSON.stringify(openAmounts)}::jsonb)
      ), user_amounts as (
        select user_id, sum(sandbox) as sandbox, sum(input) as input,
          sum(output) as output, sum(open) as open
        from amounts group by user_id
      ), matching as (
        select u.id, u.name, u.username, a.sandbox, a.input, a.output, a.open
        from user_amounts a join users u on u.id = a.user_id
        where ${request.q} = '' or strpos(
          translate(lower(u.name), 'АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ', 'абвгдеёжзийклмнопрстуфхцчшщъыьэюя'),
          ${request.q}) > 0
          or strpos(lower(coalesce(u.username, '')), lower(${request.q})) > 0
          or starts_with(u.telegram_id::text, ${request.q})
      )`;
    const [count] = await tx.execute<{ total: string }>(sql`${users} select count(*)::text as total from matching`);
    const total = Number(count.total);
    const pageSize = 100;
    const page = Math.min(request.page, Math.max(1, Math.ceil(total / pageSize)));
    const byUser = await tx.execute<AdminUsageResponse["byUser"][number]>(sql`
      ${users}
      select jsonb_build_object('id', id, 'name', name, 'username', username) as "user",
        sandbox::float8 as "sandboxSeconds", input::float8 as "inputTokens",
        output::float8 as "outputTokens", open::float8 as "openSandboxSeconds"
      from matching
      order by (case when ${request.metric} = 'tokens' then input + output else sandbox + open end) desc, id asc
      limit ${pageSize} offset ${(page - 1) * pageSize}`);
    return {
      period: request.period, totals, byDay, byUser,
      othersCount: Math.max(0, total - page * pageSize),
      usersPage: { page, pageSize, total },
    };
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}
