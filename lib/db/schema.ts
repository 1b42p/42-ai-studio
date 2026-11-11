import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Пользователи сервиса. Из этой таблицы вырастет вход (#4).
 *
 * Соглашения: таблицы во множественном числе в `snake_case`, первичные ключи —
 * uuid, время — `timestamptz`; у таблиц с данными пользователя есть внешний ключ
 * на `users(id)` или будущую `app_sessions(id)` с `ON DELETE CASCADE`.
 */
export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** Telegram ID помещается в 53 бита, поэтому в схеме — `number`. */
  telegramId: bigint("telegram_id", { mode: "number" }).notNull().unique(),
  name: text("name").notNull(),
  username: text("username"),
  photoUrl: text("photo_url"),
  isOperator: boolean("is_operator").notNull().default(false),
  isBlocked: boolean("is_blocked").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
});

/**
 * Серверные сессии входа. В базе лежит только SHA-256 токена из cookie,
 * поэтому утечка таблицы не даёт готовых cookie.
 */
export const authSessions = pgTable("auth_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Одноразовые nonce входа OIDC. В базе лежит SHA-256 значения:
 * строка удаляется при первом использовании, поэтому повторная пара
 * «nonce + id_token» уже не пройдёт.
 */
export const loginNonces = pgTable("login_nonces", {
  id: uuid("id").primaryKey().defaultRandom(),
  nonceHash: text("nonce_hash").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

/**
 * Сессия приложения: строка в адресе `/s/<id>` и связь пользователя с durable
 * сессией eve. Пока пользователь не отправил первое сообщение, `eve_session_id`
 * пуст; `stream_cursor` — сколько событий потока eve уже сохранено, то есть
 * номер, с которого читать дальше.
 */
export const appSessions = pgTable(
  "app_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    eveSessionId: text("eve_session_id").unique(),
    title: text("title"),
    /**
     * Название в нижнем регистре с «ё» → «е», посчитанное в приложении.
     * `lower()` в Postgres зависит от LC_CTYPE и в локали C кириллицу не трогает.
     */
    titleSearch: text("title_search"),
    streamCursor: integer("stream_cursor").notNull().default(0),
    /** Когда пользователь начал создание сессии eve; окно привязки — 60 секунд. */
    startRequestedAt: timestamp("start_requested_at", { withTimezone: true }),
    sandboxWorkState: text("sandbox_work_state").$type<"active" | "input" | "idle">().notNull().default("idle"),
    sandboxWorkTurnId: text("sandbox_work_turn_id"),
    sandboxWorkEventId: text("sandbox_work_event_id"),
    sandboxWaitGeneration: integer("sandbox_wait_generation").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true, precision: 3 }).notNull().defaultNow(),
    /**
     * Миллисекундная точность: по этому столбцу #6 строит постраничную выдачу,
     * а `Date` в JavaScript не хранит микросекунды.
     */
    updatedAt: timestamp("updated_at", { withTimezone: true, precision: 3 })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("app_sessions_user_list_idx")
      .on(table.userId, table.updatedAt.desc(), table.id.desc())
      .where(sql`${table.eveSessionId} is not null`),
  ],
);

/**
 * События потока eve, сохранённые для показа истории. `seq` — абсолютный
 * номер события в потоке (с нуля), поэтому таблица хранит непрерывный префикс
 * потока, а `stream_cursor` сессии указывает, с какого номера читать дальше.
 */
export const sessionEvents = pgTable(
  "session_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    appSessionId: uuid("app_session_id")
      .notNull()
      .references(() => appSessions.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    /** `meta.id` события; у очень старых событий его может не быть. */
    eventId: text("event_id"),
    /** Событие целиком: `type`, `data`, `meta`, как приходит из потока. */
    payload: jsonb("payload").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("session_events_app_session_seq_idx").on(table.appSessionId, table.seq),
    uniqueIndex("session_events_app_session_event_idx").on(
      table.appSessionId,
      table.eventId,
    ),
  ],
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type AuthSession = typeof authSessions.$inferSelect;
export type LoginNonce = typeof loginNonces.$inferSelect;
export type AppSession = typeof appSessions.$inferSelect;
export type NewAppSession = typeof appSessions.$inferInsert;
export type SessionEvent = typeof sessionEvents.$inferSelect;

/**
 * Сессия копии агента (#12): встроенный инструмент `agent` открывает дочернюю
 * сессию eve, и её поток читается теми же учётными данными, что поток корня.
 * eve владельца не сверяет, поэтому строка нужна проверке доступа в канале.
 * Появляется синхронизатором событий вместе с `agent.started`.
 */
export const agentSessions = pgTable(
  "agent_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    appSessionId: uuid("app_session_id")
      .notNull()
      .references(() => appSessions.id, { onDelete: "cascade" }),
    /** Идентификатор сессии копии в eve: по нему открывается поток. */
    eveSessionId: text("eve_session_id").notNull().unique(),
    /** Задача копии; пусто, если `agent.started` пришёл без неё. */
    taskId: text("task_id"),
    /** Вызов, открывший сессию копии. */
    callId: text("call_id").notNull(),
    /** Имя агента из `agent.started`. */
    name: text("name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("agent_sessions_app_session_idx").on(table.appSessionId)],
);

export type AgentSession = typeof agentSessions.$inferSelect;

/** Участники общей песочницы: ожидание одной копии не освобождает остальные. */
export const sandboxWorkers = pgTable("sandbox_workers", {
  id: uuid("id").primaryKey().defaultRandom(),
  appSessionId: uuid("app_session_id").notNull()
    .references(() => appSessions.id, { onDelete: "cascade" }),
  eveSessionId: text("eve_session_id").notNull().unique(),
  turnId: text("turn_id"),
  turnSequence: integer("turn_sequence").notNull().default(0),
  state: text("state").$type<"active" | "input" | "idle">().notNull().default("idle"),
  eventId: text("event_id"),
}, (table) => [index("sandbox_workers_busy_idx").on(table.appSessionId, table.state)]);

/** Неизменяемая привязка хода: повтор старого шага не получает новое поколение. */
export const sandboxWaitTurns = pgTable("sandbox_wait_turns", {
  id: uuid("id").primaryKey().defaultRandom(),
  appSessionId: uuid("app_session_id").notNull()
    .references(() => appSessions.id, { onDelete: "cascade" }),
  turnId: text("turn_id").notNull(),
  scopeId: text("scope_id").notNull().default("root"),
  generation: integer("generation").notNull(),
}, (table) => [uniqueIndex("sandbox_wait_turns_identity_idx").on(table.appSessionId, table.scopeId, table.turnId)]);

/** Вызов возобновляемой задачи, а не неизменяемая lineage сессии копии. */
export const sandboxTaskCalls = pgTable("sandbox_task_calls", {
  id: uuid("id").primaryKey().defaultRandom(),
  appSessionId: uuid("app_session_id").notNull()
    .references(() => appSessions.id, { onDelete: "cascade" }),
  taskId: text("task_id").notNull(),
  callId: text("call_id").notNull(),
  turnId: text("turn_id").notNull(),
  generation: integer("generation").notNull(),
  kind: text("kind").$type<"agent" | "tool">().notNull(),
  state: text("state").$type<"active" | "settled">().notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("sandbox_task_calls_identity_idx").on(table.appSessionId, table.callId),
  index("sandbox_task_calls_task_idx").on(table.appSessionId, table.taskId, table.createdAt),
]);

/** Ключи организации, не данные пользователя. Удаление ключа — мягкое. */
export const daytonaKeys = pgTable("daytona_keys", {
  id: uuid("id").primaryKey().defaultRandom(),
  label: text("label").notNull(),
  apiKeyEncrypted: text("api_key_encrypted").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  usage: jsonb("usage").$type<Record<string, unknown>>(),
  usageCheckedAt: timestamp("usage_checked_at", { withTimezone: true }),
  /**
   * До какого времени пул организации считается исчерпанным после отказа
   * Daytona по квоте. Хранится отдельно от `usage`, чтобы обновление
   * использования не затирало отметку.
   */
  exhaustedUntil: timestamp("exhausted_until", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const sandboxState = pgEnum("sandbox_state", [
  "starting", "started", "stopped", "archived", "gone",
]);

/** Вид запуска, под который строка `sandboxes` держит место в квоте пула. */
export const sandboxLaunch = pgEnum("sandbox_launch", ["create", "wake", "restore"]);

export const sandboxes = pgTable("sandboxes", {
  id: uuid("id").primaryKey().defaultRandom(),
  appSessionId: uuid("app_session_id").notNull().unique()
    .references(() => appSessions.id, { onDelete: "cascade" }),
  daytonaKeyId: uuid("daytona_key_id").notNull().references(() => daytonaKeys.id),
  daytonaSandboxId: text("daytona_sandbox_id").notNull(),
  state: sandboxState("state").notNull(),
  /** Когда строка перешла в `starting`; данные Daytona отстают от изменения. */
  startingSince: timestamp("starting_since", { withTimezone: true }),
  /** Что резервирует строка в квоте пула: создание, пробуждение или восстановление. */
  startingKind: sandboxLaunch("starting_kind"),
  slotRequestId: uuid("slot_request_id"),
  waitGeneration: integer("wait_generation").notNull().default(0),
  launchStartedAt: timestamp("launch_started_at", { withTimezone: true }),
  stoppedAt: timestamp("stopped_at", { withTimezone: true }),
  daytonaActivityAt: timestamp("daytona_activity_at", { withTimezone: true }),
  maintenanceToken: uuid("maintenance_token"),
  maintenanceUntil: timestamp("maintenance_until", { withTimezone: true }),
  lastActiveAt: timestamp("last_active_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type DaytonaKey = typeof daytonaKeys.$inferSelect;
export type NewDaytonaKey = typeof daytonaKeys.$inferInsert;
export type Sandbox = typeof sandboxes.$inferSelect;
export type NewSandbox = typeof sandboxes.$inferInsert;
export type SandboxState = (typeof sandboxState.enumValues)[number];
export type SandboxLaunch = (typeof sandboxLaunch.enumValues)[number];

export const queueReason = pgEnum("queue_reason", ["capacity", "own_session_busy"]);

export const queueEntries = pgTable("queue_entries", {
  id: uuid("id").primaryKey().defaultRandom(),
  appSessionId: uuid("app_session_id").notNull().unique()
    .references(() => appSessions.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  enqueuedAt: timestamp("enqueued_at", { withTimezone: true }).notNull().defaultNow(),
  need: sandboxLaunch("need").notNull(),
  daytonaKeyId: uuid("daytona_key_id").references(() => daytonaKeys.id),
  reason: queueReason("reason").notNull().default("capacity"),
  heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }).notNull().defaultNow(),
  waitGeneration: integer("wait_generation").notNull().default(0),
}, (table) => [index("queue_entries_order_idx").on(table.enqueuedAt, table.id)]);

/** Короткая аренда прохода: сеть выполняется без открытой транзакции/соединения. */
export const sandboxDispatchers = pgTable("sandbox_dispatchers", {
  id: uuid("id").primaryKey(),
  leaseToken: uuid("lease_token"),
  leaseUntil: timestamp("lease_until", { withTimezone: true }),
  reconciledAt: timestamp("reconciled_at", { withTimezone: true }),
});

export type QueueEntry = typeof queueEntries.$inferSelect;

/**
 * Машина, которую не удалось удалить при удалении ключа. Идентификатор
 * переживает переход сессии на новую песочницу, иначе повторная операция
 * удаления потеряет машину и затрёт шифротекст ключа.
 */
export const pendingSandboxDeletions = pgTable(
  "pending_sandbox_deletions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    daytonaKeyId: uuid("daytona_key_id")
      .notNull()
      .references(() => daytonaKeys.id, { onDelete: "cascade" }),
    daytonaSandboxId: text("daytona_sandbox_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("pending_sandbox_deletions_key_sandbox_idx").on(
      table.daytonaKeyId,
      table.daytonaSandboxId,
    ),
  ],
);

export type PendingSandboxDeletion = typeof pendingSandboxDeletions.$inferSelect;

/** Вид медиа: загрузка, медиа инструмента, файл ответа, превью сессии. */
export const mediaKind = pgEnum("media_kind", [
  "upload",
  "tool_media",
  "message_file",
  "preview",
]);

/**
 * Объект в S3, принадлежащий пользователю и сессии. `object_key` — полный
 * ключ вида `u/<user_id>/s/<app_session_id>/<вид>/<uuid>/<имя файла>`.
 */
export const media = pgTable("media", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  appSessionId: uuid("app_session_id")
    .notNull()
    .references(() => appSessions.id, { onDelete: "cascade" }),
  kind: mediaKind("kind").notNull(),
  objectKey: text("object_key").notNull(),
  contentType: text("content_type").notNull(),
  sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
  originalName: text("original_name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Состояние копирования файла из ответа агента в S3. */
export const messageFileState = pgEnum("message_file_state", [
  "copying",
  "ready",
  "missing",
]);

/** Причина, по которой файл ответа не сохранён. */
export const messageFileReason = pgEnum("message_file_reason", [
  "not_found",
  "outside_workspace",
  "too_large",
  "too_many",
  "copy_failed",
]);

/**
 * Файл, на который сослался агент в сообщении. Строка создаётся в состоянии
 * `copying` и становится `ready` после копии в S3 или `missing` с причиной.
 * `message_id` — `<turnId>:<stepIndex>` из событий потока.
 */
export const messageFiles = pgTable(
  "message_files",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    appSessionId: uuid("app_session_id")
      .notNull()
      .references(() => appSessions.id, { onDelete: "cascade" }),
    messageId: text("message_id").notNull(),
    sandboxPath: text("sandbox_path").notNull(),
    mediaId: uuid("media_id").references(() => media.id, { onDelete: "cascade" }),
    state: messageFileState("state").notNull(),
    reason: messageFileReason("reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("message_files_message_path_idx").on(
      table.appSessionId,
      table.messageId,
      table.sandboxPath,
    ),
  ],
);

/**
 * Медиа, приложенное к вызову инструмента: карточка вызова показывает файл
 * из песочницы. Повторный шаг с тем же `call_id` и путём не создаёт вторую
 * строку.
 */
export const toolCallMedia = pgTable(
  "tool_call_media",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    appSessionId: uuid("app_session_id")
      .notNull()
      .references(() => appSessions.id, { onDelete: "cascade" }),
    callId: text("call_id").notNull(),
    sandboxPath: text("sandbox_path").notNull(),
    mediaId: uuid("media_id")
      .notNull()
      .references(() => media.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("tool_call_media_call_path_idx").on(
      table.appSessionId,
      table.callId,
      table.sandboxPath,
    ),
  ],
);

export type Media = typeof media.$inferSelect;
export type NewMedia = typeof media.$inferInsert;
export type MediaKind = (typeof mediaKind.enumValues)[number];
export type MessageFile = typeof messageFiles.$inferSelect;
export type NewMessageFile = typeof messageFiles.$inferInsert;
export type MessageFileState = (typeof messageFileState.enumValues)[number];
export type MessageFileReason = (typeof messageFileReason.enumValues)[number];
export type ToolCallMedia = typeof toolCallMedia.$inferSelect;

/** Состояние фоновой команды `bash` из задания eve. */
export const bashJobStatus = pgEnum("bash_job_status", [
  "running",
  "completed",
  "interrupted",
]);

/**
 * Фоновая команда `bash`, ушедшая в `/tmp/.eve/jobs/<job_id>/` (#11). Строка
 * создаётся синхронизатором событий по результату вызова со статусом
 * `running`; маршрут чтения задания обновляет её выводом из песочницы.
 */
export const bashJobs = pgTable(
  "bash_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    appSessionId: uuid("app_session_id")
      .notNull()
      .references(() => appSessions.id, { onDelete: "cascade" }),
    jobId: text("job_id").notNull(),
    status: bashJobStatus("status").notNull(),
    exitCode: integer("exit_code"),
    stdoutTail: text("stdout_tail").notNull().default(""),
    stderrTail: text("stderr_tail").notNull().default(""),
    stdoutBytes: bigint("stdout_bytes", { mode: "number" }).notNull().default(0),
    stderrBytes: bigint("stderr_bytes", { mode: "number" }).notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, precision: 3 })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("bash_jobs_app_session_job_idx").on(table.appSessionId, table.jobId),
  ],
);

export type BashJob = typeof bashJobs.$inferSelect;
export type NewBashJob = typeof bashJobs.$inferInsert;
export type BashJobStatus = (typeof bashJobStatus.enumValues)[number];
