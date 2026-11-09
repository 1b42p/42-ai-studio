/**
 * Серверный модуль конфигурации: единственное место, где читаются переменные
 * окружения проекта. Остальной код `process.env` напрямую не читает (исключение —
 * переменные самого фреймворка: `NODE_ENV`, `PORT`, `EVE_*`).
 *
 * Файлы `.env*` читаются через `loadEnvConfig` из `@next/env` — тем же механизмом,
 * что и Next.js. Переменные, заданные в самом процессе, главнее файлов.
 *
 * Правило для следующих тикетов: любая новая переменная появляется здесь, в
 * `.env.example` и, если без неё сервер перестанет стартовать в тестах, в `.env.test`.
 */
import * as nextEnv from "@next/env";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";

import { isValidSecretsEncryptionKey } from "./secrets";

// Node ESM exposes this CommonJS package through default; bundlers may expose
// its named members directly. Normalize both module namespace shapes.
const { loadEnvConfig } = (nextEnv as typeof nextEnv & { default?: typeof nextEnv }).default ?? nextEnv;

/** Ошибка конфигурации: каждая строка списка — «ИМЯ: причина». */
export class ConfigError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(
      `Некорректная конфигурация окружения:\n${issues.map((issue) => `  - ${issue}`).join("\n")}`,
    );
    this.name = "ConfigError";
    this.issues = issues;
  }
}

/** Уровни рассуждения, которые понимает AI SDK. */
export const AGENT_REASONING_VALUES = [
  "provider-default",
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;

export type AgentReasoning = (typeof AGENT_REASONING_VALUES)[number];

/** Типизированный объект конфигурации. */
export interface AppConfig {
  /** Строка подключения к Postgres. */
  readonly databaseUrl: string;
  /** URL S3-совместимого API. */
  readonly s3Endpoint: string;
  /** Регион хранилища (для MinIO подойдёт любой). */
  readonly s3Region: string;
  /** Имя бакета. */
  readonly s3Bucket: string;
  /** Ключ доступа к хранилищу. */
  readonly s3AccessKeyId: string;
  /** Секретный ключ хранилища. */
  readonly s3SecretAccessKey: string;
  /** Адресация «хост/бакет/ключ» (так требует MinIO). */
  readonly s3ForcePathStyle: boolean;
  /** Публичный адрес приложения без завершающего «/». */
  readonly appUrl: string;
  /** Тестовые подмены (появятся в следующих тикетах). */
  readonly appTestMode: boolean;
  /** Изолированные оценки настоящей модели; только локально, не в production. */
  readonly appEvalMode: boolean;
  readonly appVideoEvalSandbox: boolean;
  readonly appStubEvalSandbox: boolean;
  readonly eveEvalAuthToken: string | undefined;
  /** Порт основного экземпляра приложения в HTTP-тестах. */
  readonly testAppPort: number;
  /** Каталог сборки Next.js. */
  readonly nextDistDir: string;
  /** Client ID (Bot ID) из @BotFather; `aud` в `id_token`. */
  readonly telegramClientId: string | undefined;
  /** Client Secret для серверного обмена кода авторизации. */
  readonly telegramClientSecret: string | undefined;
  /** Издатель OIDC, от него берётся discovery-документ. */
  readonly telegramOidcIssuer: string;
  /** Секрет подписи короткоживущей cookie входа OIDC. */
  readonly sessionSecret: string;
  /** Срок жизни сессии входа в днях. */
  readonly sessionTtlDays: number;
  /** Вход без Telegram для локальной разработки. */
  readonly devLoginEnabled: boolean;
  /** Имя модели агента; вне тестового режима обязательно. */
  readonly agentModel: string | undefined;
  /** Базовый URL OpenAI-совместимого провайдера. */
  readonly agentModelBaseUrl: string | undefined;
  /** Ключ OpenAI-совместимого провайдера. */
  readonly agentModelApiKey: string | undefined;
  /** Размер контекстного окна модели в токенах. */
  readonly agentModelContextTokens: number | undefined;
  readonly agentModelStreaming: boolean;
  /** Уровень рассуждения модели. */
  readonly agentReasoning: AgentReasoning;
  /** Необязательная модель судьи; используется процессом eve eval, не агентом. */
  readonly evalJudgeModel: string | undefined;
  /** Ключ шифрования секретов в базе: 32 байта в каноническом base64. */
  readonly secretsEncryptionKey: string;
  readonly daytonaApiUrl: string;
  readonly sandboxCpu: number;
  readonly sandboxMemoryGb: number;
  readonly sandboxDiskGb: number;
  /** Предельный размер файла, который копируется из ответа агента в S3. */
  readonly mediaCopyMaxBytes: number;
  /** Предельный размер одного загружаемого файла, байты. */
  readonly uploadMaxBytes: number;
  /** Ключ Tavily. Без него сервер стартует, а `web_search` отвечает, что поиск не настроен. */
  readonly tavilyApiKey: string | undefined;
  /** Базовый адрес API Tavily без завершающего «/». */
  readonly tavilyApiUrl: string;
  /** Абсолютный путь; обязателен только в тестовом режиме. */
  readonly fakeSandboxDir: string | undefined;
  /** WebSocket синтеза Edge TTS. Пусто — адрес библиотеки. */
  readonly edgeTtsWssUrl: string | undefined;
  /** Список голосов Edge TTS. Пусто — адрес библиотеки. */
  readonly edgeTtsVoicesUrl: string | undefined;
  /** Исполняемый файл yt-dlp. По умолчанию имя из PATH. */
  readonly ytdlpPath: string;
  /** Каталог или файл ffmpeg для yt-dlp. Пусто — ffmpeg из PATH самого yt-dlp. */
  readonly ffmpegPath: string | undefined;
  /** Исполняемый файл ffprobe. По умолчанию имя из PATH. */
  readonly ffprobePath: string;
  /** Среда JavaScript для yt-dlp: `node` или `deno`. `bun` отвергается при вызове. */
  readonly ytdlpJsRuntime: string;
  /** Текст cookies Netscape. Пусто — YouTube без входа. */
  readonly youtubeCookies: string | undefined;
  /** Предел размера скачиваемого видео, байты. */
  readonly downloadMaxBytes: number;
  /** Срок метаданных и скачивания yt-dlp, миллисекунды. */
  readonly downloadTimeoutMs: number;
}

/** Значение из `.env.example`: в production не годится в качестве секрета. */
const EXAMPLE_SESSION_SECRET = "dev-only-session-secret-change-me-0123456789abcd";

/** Предел одного файла по умолчанию: 256 МиБ. */
export const UPLOAD_MAX_BYTES_DEFAULT = 268_435_456;
/** Больше 5 ГБ одиночный PUT в S3 не принимает. */
export const UPLOAD_MAX_BYTES_LIMIT = 5_368_709_120;

const uploadMaxBytesSchema = z.coerce
  .number({ error: "ожидается целое число больше нуля" })
  .int("ожидается целое число больше нуля")
  .min(1, "ожидается целое число больше нуля")
  .max(UPLOAD_MAX_BYTES_LIMIT, `не больше ${UPLOAD_MAX_BYTES_LIMIT} (5 ГБ)`)
  .optional()
  .default(UPLOAD_MAX_BYTES_DEFAULT);

/**
 * Один помощник для логических значений: `1`, `0`, `true`, `false`.
 * `z.coerce.boolean()` не годится — строка `«false»` стала бы `true`.
 */
const envBoolean = z
  .string({ error: "ожидается одно из значений: 1, 0, true, false" })
  .transform((value, ctx) => {
    switch (value.trim().toLowerCase()) {
      case "1":
      case "true":
        return true;
      case "0":
      case "false":
        return false;
      default:
        ctx.addIssue({
          code: "custom",
          message: "ожидается одно из значений: 1, 0, true, false",
        });
        return z.NEVER;
    }
  });

const envString = z
  .string({ error: "обязательная переменная не задана" })
  .min(1, "обязательная переменная не задана");

/** Форма проверяется как URL; доступность сервиса видит `/api/health`. */
const envUrl = envString.refine((value) => {
  try {
    // Абсолютный URL с хостом: иначе и «localhost:59000» выглядит как URL
    // (схема localhost, непрозрачный путь).
    return new URL(value).host !== "";
  } catch {
    return false;
  }
}, "ожидается корректный URL");

const envSchema = z.object({
  SECRETS_ENCRYPTION_KEY: envString.refine(
    isValidSecretsEncryptionKey,
    "ожидается 32 байта в каноническом base64",
  ),
  DAYTONA_API_URL: envUrl
    .refine((value) => /^https?:\/\//.test(value), "ожидается URL с http:// или https://")
    .optional().default("https://app.daytona.io/api"),
  SANDBOX_CPU: z.coerce.number().int().min(1).max(4).optional().default(2),
  SANDBOX_MEMORY_GB: z.coerce.number().int().min(3).max(8).optional().default(4),
  SANDBOX_DISK_GB: z.coerce.number().int().min(1).max(10).optional().default(8),
  MEDIA_COPY_MAX_BYTES: z.coerce
    .number({ error: "ожидается целое число больше нуля" })
    .int("ожидается целое число больше нуля")
    .min(1, "ожидается целое число больше нуля")
    .max(Number.MAX_SAFE_INTEGER, "слишком большой размер")
    .optional()
    .default(2_147_483_648),
  UPLOAD_MAX_BYTES: uploadMaxBytesSchema,
  FAKE_SANDBOX_DIR: envString.refine((value) => !value.includes("\0"), "некорректный путь").optional(),
  DATABASE_URL: envUrl,
  S3_ENDPOINT: envUrl,
  S3_REGION: envString,
  S3_BUCKET: envString,
  S3_ACCESS_KEY_ID: envString,
  S3_SECRET_ACCESS_KEY: envString,
  S3_FORCE_PATH_STYLE: envBoolean.optional().default(false),
  APP_URL: envUrl.refine(
    (value) => !value.endsWith("/"),
    "не должен заканчиваться на /",
  ),
  APP_TEST_MODE: envBoolean.optional().default(false),
  APP_EVAL_MODE: envBoolean.optional().default(false),
  APP_VIDEO_EVAL_SANDBOX: envBoolean.optional().default(false),
  APP_STUB_EVAL_SANDBOX: envBoolean.optional().default(false),
  EVE_EVAL_AUTH_TOKEN: envString.min(24, "токен должен быть не короче 24 символов").optional(),
  TEST_APP_PORT: z.coerce
    .number({ error: "ожидается целое число от 1 до 65535" })
    .int("ожидается целое число от 1 до 65535")
    .min(1, "ожидается целое число от 1 до 65535")
    .max(65535, "ожидается целое число от 1 до 65535")
    .optional()
    .default(3100),
  NEXT_DIST_DIR: z
    .string({ error: "не может быть пустой" })
    .min(1, "не может быть пустой")
    .optional()
    .default(".next"),
  TELEGRAM_CLIENT_ID: z
    .string({ error: "ожидается только цифры" })
    .regex(/^\d+$/, "ожидается только цифры")
    .optional(),
  TELEGRAM_CLIENT_SECRET: envString.optional(),
  TELEGRAM_OIDC_ISSUER: envUrl
    .refine((value) => !value.endsWith("/"), "не должен заканчиваться на /")
    .optional()
    .default("https://oauth.telegram.org"),
  SESSION_SECRET: envString.min(32, "секрет должен быть не короче 32 символов"),
  SESSION_TTL_DAYS: z.coerce
    .number({ error: "ожидается целое число от 1 до 365" })
    .int("ожидается целое число от 1 до 365")
    .min(1, "ожидается целое число от 1 до 365")
    .max(365, "ожидается целое число от 1 до 365")
    .optional()
    .default(30),
  DEV_LOGIN_ENABLED: envBoolean.optional().default(false),
  AGENT_MODEL: envString.optional(),
  AGENT_MODEL_BASE_URL: envUrl.optional(),
  AGENT_MODEL_API_KEY: envString.optional(),
  AGENT_MODEL_STREAMING: envBoolean.optional().default(true),
  EVAL_JUDGE_MODEL: envString.trim().optional(),
  EVAL_CHECKPOINT_DIR: envString.optional(),
  AGENT_MODEL_CONTEXT_TOKENS: z.coerce
    .number({ error: "ожидается целое число не меньше 8000" })
    .int("ожидается целое число не меньше 8000")
    .min(8000, "ожидается целое число не меньше 8000")
    .optional(),
  AGENT_REASONING: z
    .enum(AGENT_REASONING_VALUES, {
      error: `ожидается одно из значений: ${AGENT_REASONING_VALUES.join(", ")}`,
    })
    .optional()
    .default("high"),
  TAVILY_API_KEY: envString.optional(),
  TAVILY_API_URL: envUrl
    .refine((value) => /^https?:\/\//.test(value), "ожидается URL с http:// или https://")
    .refine((value) => !value.endsWith("/"), "не должен заканчиваться на /")
    .optional()
    .default("https://api.tavily.com"),
  EDGE_TTS_WSS_URL: envUrl
    .refine((value) => {
      const protocol = new URL(value).protocol;
      return protocol === "ws:" || protocol === "wss:";
    }, "ожидается URL с ws:// или wss://")
    .optional(),
  EDGE_TTS_VOICES_URL: envUrl
    .refine((value) => /^https?:\/\//.test(value), "ожидается URL с http:// или https://")
    .optional(),
  YTDLP_PATH: envString.optional().default("yt-dlp"),
  FFMPEG_PATH: envString.optional(),
  FFPROBE_PATH: envString.optional().default("ffprobe"),
  YTDLP_JS_RUNTIME: envString.optional().default("node"),
  YOUTUBE_COOKIES: z.string().optional(),
  DOWNLOAD_MAX_BYTES: z.coerce
    .number({ error: "ожидается целое число не меньше 1048576" })
    .int("ожидается целое число не меньше 1048576")
    .min(1_048_576, "ожидается целое число не меньше 1048576")
    .optional()
    .default(1_073_741_824),
  DOWNLOAD_TIMEOUT_MS: z.coerce
    .number({ error: "ожидается целое число от 10000 до 3600000" })
    .int("ожидается целое число от 10000 до 3600000")
    .min(10_000, "ожидается целое число от 10000 до 3600000")
    .max(3_600_000, "ожидается целое число от 10000 до 3600000")
    .optional()
    .default(600_000),
});

/**
 * Настоящие переводы строк, затем литералы `\r\n`, `\n` и `\t` из одной строки `.env`.
 * Так файл Netscape собирается и из многострочного значения, и из одной строки.
 */
export function normalizeCookieText(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\\r\\n/g, "\n").replace(/\\n/g, "\n").replace(/\\t/g, "\t");
}

function cookieHeaderValid(value: string): boolean {
  const first = value.split("\n")[0]?.trim();
  return first === "# Netscape HTTP Cookie File" || first === "# HTTP Cookie File";
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function isLocalHost(appUrl: string): boolean {
  try {
    return LOCAL_HOSTS.has(new URL(appUrl).hostname);
  } catch {
    return false;
  }
}

/** Запись окружения: как `process.env`. */
export type EnvRecord = Record<string, string | undefined>;

function formatIssues(error: z.ZodError): string[] {
  const byName = new Map<string, string>();
  for (const issue of error.issues) {
    const name = issue.path.join(".") || "конфигурация";
    if (!byName.has(name)) byName.set(name, issue.message);
  }
  return [...byName].map(([name, message]) => `${name}: ${message}`);
}

/**
 * Чистая проверка: принимает запись окружения, отдаёт типизированный объект
 * или бросает `ConfigError` с именами переменных и причинами. Файлы не читает.
 */
export function parseConfig(env: EnvRecord): AppConfig {
  // Пустая строка — как отсутствующая переменная.
  const normalized: EnvRecord = {};
  for (const [name, value] of Object.entries(env)) {
    normalized[name] = value === undefined || value.trim() === "" ? undefined : value;
  }

  const result = envSchema.safeParse(normalized);
  const issues: string[] = result.success ? [] : formatIssues(result.error);
  const extra = new Map<string, string>();
  const addIssue = (name: string, message: string) => {
    if (extra.has(name)) return;
    extra.set(name, `${name}: ${message}`);
  };

  let youtubeCookies: string | undefined;
  if (result.success) {
    const data = result.data;
    const production = normalized.NODE_ENV === "production";
    if (data.YOUTUBE_COOKIES !== undefined) {
      youtubeCookies = normalizeCookieText(data.YOUTUBE_COOKIES);
      if (!cookieHeaderValid(youtubeCookies)) {
        addIssue(
          "YOUTUBE_COOKIES",
          "первая строка должна быть «# Netscape HTTP Cookie File» или «# HTTP Cookie File»",
        );
      }
    }

    if (data.APP_TEST_MODE && data.FAKE_SANDBOX_DIR === undefined) {
      addIssue("FAKE_SANDBOX_DIR", "обязательна при APP_TEST_MODE=1");
    }

    if (data.APP_TEST_MODE && production) {
      addIssue("APP_TEST_MODE", "тестовые подмены запрещены при NODE_ENV=production");
    }

    if (data.APP_EVAL_MODE) {
      if (production) addIssue("APP_EVAL_MODE", "оценки запрещены при NODE_ENV=production");
      if (!isLocalHost(data.APP_URL)) addIssue("APP_URL", "оценки разрешены только на localhost, 127.0.0.1 или [::1]");
      if (!data.EVE_EVAL_AUTH_TOKEN) addIssue("EVE_EVAL_AUTH_TOKEN", "обязательна при APP_EVAL_MODE=1");
    }
    if (data.APP_VIDEO_EVAL_SANDBOX && !data.APP_EVAL_MODE) {
      addIssue("APP_VIDEO_EVAL_SANDBOX", "требует APP_EVAL_MODE=1");
    }
    if (data.APP_STUB_EVAL_SANDBOX && !data.APP_EVAL_MODE) {
      addIssue("APP_STUB_EVAL_SANDBOX", "требует APP_EVAL_MODE=1");
    }
    if (data.APP_STUB_EVAL_SANDBOX && data.APP_VIDEO_EVAL_SANDBOX) {
      addIssue("APP_STUB_EVAL_SANDBOX", "несовместима с APP_VIDEO_EVAL_SANDBOX=1");
    }

    if (production) {
      if (data.TELEGRAM_CLIENT_ID === undefined) {
        addIssue("TELEGRAM_CLIENT_ID", "обязательна при NODE_ENV=production");
      }
      if (data.TELEGRAM_CLIENT_SECRET === undefined) {
        addIssue("TELEGRAM_CLIENT_SECRET", "обязательна при NODE_ENV=production");
      }
      if (data.SESSION_SECRET === EXAMPLE_SESSION_SECRET) {
        addIssue("SESSION_SECRET", "пример из .env.example не годится для production");
      }
    }

    if (data.TELEGRAM_CLIENT_ID !== undefined && data.TELEGRAM_CLIENT_SECRET === undefined) {
      addIssue("TELEGRAM_CLIENT_SECRET", "нужна вместе с TELEGRAM_CLIENT_ID");
    }
    if (data.TELEGRAM_CLIENT_SECRET !== undefined && data.TELEGRAM_CLIENT_ID === undefined) {
      addIssue("TELEGRAM_CLIENT_ID", "нужна вместе с TELEGRAM_CLIENT_SECRET");
    }

    if (data.DEV_LOGIN_ENABLED && production) {
      addIssue("DEV_LOGIN_ENABLED", "вход без Telegram запрещён при NODE_ENV=production");
    } else if (data.DEV_LOGIN_ENABLED && !isLocalHost(data.APP_URL)) {
      addIssue(
        "DEV_LOGIN_ENABLED",
        "вход без Telegram разрешён только на localhost, 127.0.0.1 или [::1]",
      );
    }

    if (!data.APP_TEST_MODE && !data.TELEGRAM_OIDC_ISSUER.startsWith("https://")) {
      addIssue("TELEGRAM_OIDC_ISSUER", "издатель должен работать по https://");
    }

    if (!data.APP_TEST_MODE && data.AGENT_MODEL === undefined) {
      addIssue("AGENT_MODEL", "обязательна вне APP_TEST_MODE=1");
    }

    if (!data.APP_TEST_MODE && !data.TAVILY_API_URL.startsWith("https://")) {
      addIssue("TAVILY_API_URL", "адрес должен быть https:// вне APP_TEST_MODE=1");
    }

    if (data.AGENT_MODEL_BASE_URL !== undefined) {
      if (data.AGENT_MODEL_API_KEY === undefined) {
        addIssue("AGENT_MODEL_API_KEY", "нужна вместе с AGENT_MODEL_BASE_URL");
      }
      if (data.AGENT_MODEL_CONTEXT_TOKENS === undefined) {
        addIssue("AGENT_MODEL_CONTEXT_TOKENS", "нужна вместе с AGENT_MODEL_BASE_URL");
      }
    }
    if (!data.AGENT_MODEL_STREAMING && !data.AGENT_MODEL_BASE_URL && !data.APP_TEST_MODE) {
      addIssue("AGENT_MODEL_STREAMING", "false поддерживается только с AGENT_MODEL_BASE_URL");
    }
  }

  const allIssues = [...issues, ...extra.values()];
  if (allIssues.length > 0) throw new ConfigError(allIssues);

  const data = (result as z.ZodSafeParseSuccess<z.infer<typeof envSchema>>).data;
  return {
    databaseUrl: data.DATABASE_URL,
    s3Endpoint: data.S3_ENDPOINT,
    s3Region: data.S3_REGION,
    s3Bucket: data.S3_BUCKET,
    s3AccessKeyId: data.S3_ACCESS_KEY_ID,
    s3SecretAccessKey: data.S3_SECRET_ACCESS_KEY,
    s3ForcePathStyle: data.S3_FORCE_PATH_STYLE,
    appUrl: data.APP_URL,
    appTestMode: data.APP_TEST_MODE,
    appEvalMode: data.APP_EVAL_MODE,
    appVideoEvalSandbox: data.APP_VIDEO_EVAL_SANDBOX,
    appStubEvalSandbox: data.APP_STUB_EVAL_SANDBOX,
    eveEvalAuthToken: data.EVE_EVAL_AUTH_TOKEN,
    testAppPort: data.TEST_APP_PORT,
    nextDistDir: data.NEXT_DIST_DIR,
    telegramClientId: data.TELEGRAM_CLIENT_ID,
    telegramClientSecret: data.TELEGRAM_CLIENT_SECRET,
    telegramOidcIssuer: data.TELEGRAM_OIDC_ISSUER,
    sessionSecret: data.SESSION_SECRET,
    sessionTtlDays: data.SESSION_TTL_DAYS,
    devLoginEnabled: data.DEV_LOGIN_ENABLED,
    agentModel: data.AGENT_MODEL,
    agentModelBaseUrl: data.AGENT_MODEL_BASE_URL,
    agentModelApiKey: data.AGENT_MODEL_API_KEY,
    agentModelContextTokens: data.AGENT_MODEL_CONTEXT_TOKENS,
    agentModelStreaming: data.AGENT_MODEL_STREAMING,
    agentReasoning: data.AGENT_REASONING,
    evalJudgeModel: data.EVAL_JUDGE_MODEL,
    secretsEncryptionKey: data.SECRETS_ENCRYPTION_KEY,
    daytonaApiUrl: data.DAYTONA_API_URL,
    sandboxCpu: data.SANDBOX_CPU,
    sandboxMemoryGb: data.SANDBOX_MEMORY_GB,
    sandboxDiskGb: data.SANDBOX_DISK_GB,
    mediaCopyMaxBytes: data.MEDIA_COPY_MAX_BYTES,
    uploadMaxBytes: data.UPLOAD_MAX_BYTES,
    tavilyApiKey: data.TAVILY_API_KEY,
    tavilyApiUrl: data.TAVILY_API_URL,
    fakeSandboxDir: data.FAKE_SANDBOX_DIR === undefined ? undefined : resolve(data.FAKE_SANDBOX_DIR),
    edgeTtsWssUrl: data.EDGE_TTS_WSS_URL,
    edgeTtsVoicesUrl: data.EDGE_TTS_VOICES_URL,
    ytdlpPath: data.YTDLP_PATH,
    ffmpegPath: data.FFMPEG_PATH,
    ffprobePath: data.FFPROBE_PATH,
    ytdlpJsRuntime: data.YTDLP_JS_RUNTIME,
    youtubeCookies,
    downloadMaxBytes: data.DOWNLOAD_MAX_BYTES,
    downloadTimeoutMs: data.DOWNLOAD_TIMEOUT_MS,
  };
}

/** Значения одного загруженного файла окружения. */
export interface DotenvFile {
  path: string;
  env: Record<string, string | undefined>;
}

/**
 * Загружает файлы `.env*` через `@next/env` и отдаёт их поимённо.
 * При `NODE_ENV=test` читаются `.env.test.local`, `.env.test`, `.env`
 * (без `.env.local`); иначе — `.env.<mode>.local`, `.env.local`,
 * `.env.<mode>`, `.env`. Значения файлов отдаются всегда: они нужны, чтобы
 * передать их дочернему процессу явно.
 */
export function loadDotenvFiles(): DotenvFile[] {
  const { loadedEnvFiles } = loadEnvConfig(
    process.cwd(),
    process.env.NODE_ENV !== "production",
  );
  return loadedEnvFiles.map((file) => ({ path: file.path, env: file.env }));
}

let cachedConfig: AppConfig | undefined;

/**
 * Загружает окружение и отдаёт типизированный объект.
 * Бросает `ConfigError`, если обязательная переменная отсутствует или некорректна.
 */
export function loadConfig(): AppConfig {
  if (cachedConfig === undefined) {
    loadDotenvFiles();
    cachedConfig = parseConfig(process.env);
  }
  return cachedConfig;
}

export interface EvalJudgeConfig {
  readonly model: string | undefined;
  readonly baseUrl: string | undefined;
  readonly apiKey: string | undefined;
}

// Процесс оценок может обращаться к удалённому приложению: его судье не нужны
// DATABASE_URL, S3, Telegram, ключи песочницы или окно контекста модели агента.
const evalJudgeSchema = envSchema.pick({
  EVAL_JUDGE_MODEL: true,
  AGENT_MODEL_BASE_URL: true,
  AGENT_MODEL_API_KEY: true,
});

export function parseEvalJudgeConfig(env: EnvRecord): EvalJudgeConfig {
  const result = evalJudgeSchema.safeParse({
    EVAL_JUDGE_MODEL: env.EVAL_JUDGE_MODEL?.trim() || undefined,
    AGENT_MODEL_BASE_URL: env.AGENT_MODEL_BASE_URL?.trim() || undefined,
    AGENT_MODEL_API_KEY: env.AGENT_MODEL_API_KEY?.trim() || undefined,
  });
  if (!result.success) throw new ConfigError(formatIssues(result.error));
  const data = result.data;
  if (data.EVAL_JUDGE_MODEL && data.AGENT_MODEL_BASE_URL && !data.AGENT_MODEL_API_KEY) {
    throw new ConfigError(["AGENT_MODEL_API_KEY: нужна судье вместе с AGENT_MODEL_BASE_URL"]);
  }
  return {
    model: data.EVAL_JUDGE_MODEL,
    baseUrl: data.AGENT_MODEL_BASE_URL,
    apiKey: data.AGENT_MODEL_API_KEY,
  };
}

/** Узкая конфигурация процесса eve eval; не загружает конфигурацию приложения. */
export function loadEvalJudgeConfig(): EvalJudgeConfig {
  loadDotenvFiles();
  return parseEvalJudgeConfig(process.env);
}

export function readEvalCheckpointDirectory(): string | undefined {
  loadDotenvFiles();
  const value = process.env.EVAL_CHECKPOINT_DIR?.trim();
  return value ? resolve(value) : undefined;
}

/** Non-secret identity: model, provider, reasoning, and sandbox mode, never credentials. */
export function evalRuntimeFingerprint(config = loadConfig()): string {
  return createHash("sha256").update(JSON.stringify({
    model: config.agentModel, baseUrl: config.agentModelBaseUrl,
    context: config.agentModelContextTokens, reasoning: config.agentReasoning, streaming: config.agentModelStreaming,
    fixture: config.appTestMode, videoSandbox: config.appVideoEvalSandbox,
    cpu: config.sandboxCpu, memory: config.sandboxMemoryGb, disk: config.sandboxDiskGb,
  })).digest("hex");
}

/**
 * Каталог сборки Next.js: нужен `next.config.ts` и на фазе сборки, где проверка
 * остальных переменных пропускается, поэтому читается без валидации.
 */
export function readNextDistDir(): string {
  loadDotenvFiles();
  const value = process.env.NEXT_DIST_DIR?.trim();
  return value === undefined || value === "" ? ".next" : value;
}

/**
 * Предел одного файла для канала eve. Канал исполняется и при `eve build`,
 * когда `.env` может не быть, поэтому читается только эта переменная: пустая
 * или отсутствующая даёт значение по умолчанию, а некорректная — ошибку с её
 * именем и без значения.
 */
export function readUploadMaxBytes(): number {
  loadDotenvFiles();
  const raw = process.env.UPLOAD_MAX_BYTES?.trim();
  const parsed = uploadMaxBytesSchema.safeParse(raw === undefined || raw === "" ? undefined : raw);
  if (!parsed.success) {
    const reason = parsed.error.issues[0]?.message ?? "некорректное значение";
    throw new ConfigError([`UPLOAD_MAX_BYTES: ${reason}`]);
  }
  return parsed.data;
}

/** Выбор локального провайдера оценок при discovery/build. */
export function readVideoEvalSandbox(): boolean {
  return readEvalSandboxFlag("APP_VIDEO_EVAL_SANDBOX");
}

export function readStubEvalSandbox(): boolean {
  return readEvalSandboxFlag("APP_STUB_EVAL_SANDBOX");
}

function readEvalSandboxFlag(name: "APP_VIDEO_EVAL_SANDBOX" | "APP_STUB_EVAL_SANDBOX"): boolean {
  loadDotenvFiles();
  const raw = process.env[name]?.trim();
  const parsed = envBoolean.optional().default(false).safeParse(raw || undefined);
  if (!parsed.success) throw new ConfigError([`${name}: ожидается 1, 0, true или false`]);
  if (parsed.data) {
    // Включённая подмена требует полной проверки локального eval-окружения.
    parseConfig(process.env);
  }
  return parsed.data;
}
