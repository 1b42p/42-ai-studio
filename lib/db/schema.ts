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

/** Ключи организации, не данные пользователя. Удаление ключа — мягкое. */
export const daytonaKeys = pgTable("daytona_keys", {
  id: uuid("id").primaryKey().defaultRandom(),
  label: text("label").notNull(),
  apiKeyEncrypted: text("api_key_encrypted").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  usage: jsonb("usage").$type<Record<string, unknown>>(),
  usageCheckedAt: timestamp("usage_checked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const sandboxState = pgEnum("sandbox_state", [
  "starting", "started", "stopped", "archived", "gone",
]);

export const sandboxes = pgTable("sandboxes", {
  id: uuid("id").primaryKey().defaultRandom(),
  appSessionId: uuid("app_session_id").notNull().unique()
    .references(() => appSessions.id, { onDelete: "cascade" }),
  daytonaKeyId: uuid("daytona_key_id").notNull().references(() => daytonaKeys.id),
  daytonaSandboxId: text("daytona_sandbox_id").notNull(),
  state: sandboxState("state").notNull(),
  lastActiveAt: timestamp("last_active_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type DaytonaKey = typeof daytonaKeys.$inferSelect;
export type NewDaytonaKey = typeof daytonaKeys.$inferInsert;
export type Sandbox = typeof sandboxes.$inferSelect;
export type NewSandbox = typeof sandboxes.$inferInsert;
export type SandboxState = (typeof sandboxState.enumValues)[number];

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
