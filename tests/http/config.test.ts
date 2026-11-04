/**
 * Точечные тесты чистой функции проверки конфигурации: приложение не нужно.
 */
import { describe, expect, test } from "vitest";
import { resolve } from "node:path";

import { ConfigError, parseConfig, type EnvRecord } from "../../lib/config";

/** Полный набор корректных переменных для перекрытия в отдельных тестах. */
function validEnv(): EnvRecord {
  return {
    DATABASE_URL: "postgres://studio:studio@localhost:55432/studio_test",
    S3_ENDPOINT: "http://localhost:59000",
    S3_REGION: "us-east-1",
    S3_BUCKET: "studio-test",
    S3_ACCESS_KEY_ID: "minioadmin",
    S3_SECRET_ACCESS_KEY: "minioadmin",
    S3_FORCE_PATH_STYLE: "true",
    APP_URL: "http://localhost:3100",
    APP_TEST_MODE: "1",
    TEST_APP_PORT: "3100",
    NEXT_DIST_DIR: ".next-test-3100",
    SESSION_SECRET: "test-session-secret-0123456789abcdef",
    SECRETS_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    FAKE_SANDBOX_DIR: ".tmp/fake-sandbox",
    NODE_ENV: "test",
  };
}

function issuesOf(env: EnvRecord): readonly string[] {
  try {
    parseConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) return error.issues;
    throw error;
  }
  throw new Error("ожидалась ошибка конфигурации");
}

describe("parseConfig", () => {
  test("принимает полный набор переменных и разбирает их", () => {
    const config = parseConfig(validEnv());

    expect(config.databaseUrl).toBe("postgres://studio:studio@localhost:55432/studio_test");
    expect(config.s3Endpoint).toBe("http://localhost:59000");
    expect(config.s3Region).toBe("us-east-1");
    expect(config.s3Bucket).toBe("studio-test");
    expect(config.s3AccessKeyId).toBe("minioadmin");
    expect(config.s3SecretAccessKey).toBe("minioadmin");
    expect(config.s3ForcePathStyle).toBe(true);
    expect(config.appUrl).toBe("http://localhost:3100");
    expect(config.appTestMode).toBe(true);
    expect(config.testAppPort).toBe(3100);
    expect(config.nextDistDir).toBe(".next-test-3100");
  });

  test("APP_TEST_MODE=1 при NODE_ENV=production отвергается", () => {
    const issues = issuesOf({
      ...validEnv(),
      NODE_ENV: "production",
      TELEGRAM_CLIENT_ID: "123456789",
      TELEGRAM_CLIENT_SECRET: "test-client-secret",
    });

    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("APP_TEST_MODE");
  });

  test("отсутствующая обязательная переменная называется в ошибке", () => {
    for (const name of [
      "DATABASE_URL",
      "S3_ENDPOINT",
      "S3_REGION",
      "S3_BUCKET",
      "S3_ACCESS_KEY_ID",
      "S3_SECRET_ACCESS_KEY",
      "APP_URL",
    ] as const) {
      const env = validEnv();
      delete env[name];

      const issues = issuesOf(env);
      expect(issues).toHaveLength(1);
      expect(issues[0]).toContain(name);
    }
  });

  test("пустая строка — как отсутствующая переменная", () => {
    const issues = issuesOf({ ...validEnv(), DATABASE_URL: "   " });

    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("DATABASE_URL");
    expect(issues[0]).toContain("не задана");
  });

  test("логические значения разбирает один помощник: «false» — это false", () => {
    expect(parseConfig({ ...validEnv(), S3_FORCE_PATH_STYLE: "false" }).s3ForcePathStyle).toBe(
      false,
    );
    expect(parseConfig({ ...validEnv(), S3_FORCE_PATH_STYLE: "0" }).s3ForcePathStyle).toBe(false);
    expect(
      parseConfig({
        ...validEnv(),
        APP_TEST_MODE: "false",
        AGENT_MODEL: "openai/gpt-6-luna-fast",
      }).appTestMode,
    ).toBe(false);
  });

  test("некорректное логическое значение отвергается с именем переменной", () => {
    const issues = issuesOf({ ...validEnv(), S3_FORCE_PATH_STYLE: "yes" });

    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("S3_FORCE_PATH_STYLE");
  });

  test("APP_URL с завершающим / отвергается с сообщением", () => {
    const issues = issuesOf({ ...validEnv(), APP_URL: "http://localhost:3100/" });

    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("APP_URL");
    expect(issues[0]).toContain("/");
  });

  test("DATABASE_URL и S3_ENDPOINT проверяются по форме URL", () => {
    expect(issuesOf({ ...validEnv(), DATABASE_URL: "не URL" })[0]).toContain("DATABASE_URL");
    expect(issuesOf({ ...validEnv(), S3_ENDPOINT: "localhost:59000" })[0]).toContain("S3_ENDPOINT");
  });

  test("необязательные переменные получают значения по умолчанию", () => {
    const env = validEnv();
    delete env.S3_FORCE_PATH_STYLE;
    delete env.APP_TEST_MODE;
    delete env.TEST_APP_PORT;
    delete env.NEXT_DIST_DIR;

    const config = parseConfig({ ...env, AGENT_MODEL: "openai/gpt-6-luna-fast" });

    expect(config.s3ForcePathStyle).toBe(false);
    expect(config.appTestMode).toBe(false);
    expect(config.testAppPort).toBe(3100);
    expect(config.nextDistDir).toBe(".next");
  });

  test("TEST_APP_PORT принимает только целые числа в диапазоне", () => {
    expect(issuesOf({ ...validEnv(), TEST_APP_PORT: "70000" })[0]).toContain("TEST_APP_PORT");
    expect(issuesOf({ ...validEnv(), TEST_APP_PORT: "port" })[0]).toContain("TEST_APP_PORT");
    expect(parseConfig({ ...validEnv(), TEST_APP_PORT: "3199" }).testAppPort).toBe(3199);
  });
});

describe("parseConfig: песочница и секреты", () => {
  test("параметры Daytona получают безопасные значения по умолчанию", () => {
    const config = parseConfig(validEnv());
    expect(config.secretsEncryptionKey).toBe("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=");
    expect(config.daytonaApiUrl).toBe("https://app.daytona.io/api");
    expect(config.sandboxCpu).toBe(2);
    expect(config.sandboxMemoryGb).toBe(4);
    expect(config.sandboxDiskGb).toBe(8);
    expect(config.mediaCopyMaxBytes).toBe(2_147_483_648);
    expect(config.fakeSandboxDir).toBe(resolve(".tmp/fake-sandbox"));
  });

  test("MEDIA_COPY_MAX_BYTES — целое больше нуля", () => {
    expect(issuesOf({ ...validEnv(), MEDIA_COPY_MAX_BYTES: "0" })[0]).toContain(
      "MEDIA_COPY_MAX_BYTES",
    );
    expect(issuesOf({ ...validEnv(), MEDIA_COPY_MAX_BYTES: "1.5" })[0]).toContain(
      "MEDIA_COPY_MAX_BYTES",
    );
    expect(parseConfig({ ...validEnv(), MEDIA_COPY_MAX_BYTES: "1000" }).mediaCopyMaxBytes).toBe(
      1000,
    );
  });

  test("UPLOAD_MAX_BYTES: по умолчанию 256 МиБ, не больше 5 ГиБ", () => {
    expect(parseConfig(validEnv()).tavilyApiKey).toBeUndefined();
    expect(parseConfig(validEnv()).tavilyApiUrl).toBe("https://api.tavily.com");
    expect(parseConfig({ ...validEnv(), TAVILY_API_URL: "http://127.0.0.1:59102" }).tavilyApiUrl).toBe(
      "http://127.0.0.1:59102",
    );
    expect(issuesOf({ ...validEnv(), APP_TEST_MODE: "0", AGENT_MODEL: "test-model", TAVILY_API_URL: "http://example.com" }).join("\n")).toContain(
      "TAVILY_API_URL",
    );
    expect(parseConfig(validEnv()).uploadMaxBytes).toBe(268_435_456);
    expect(parseConfig({ ...validEnv(), UPLOAD_MAX_BYTES: "1048576" }).uploadMaxBytes).toBe(
      1_048_576,
    );
    expect(
      parseConfig({ ...validEnv(), UPLOAD_MAX_BYTES: "5368709120" }).uploadMaxBytes,
    ).toBe(5_368_709_120);

    for (const value of ["6000000000", "0", "1.5", "abc"]) {
      expect(issuesOf({ ...validEnv(), UPLOAD_MAX_BYTES: value })[0]).toContain(
        "UPLOAD_MAX_BYTES",
      );
    }
  });

  test.each([undefined, "", "AA==", "A".repeat(43), "A".repeat(42) + "B=", "A".repeat(43) + "=\n"])(
    "неверный ключ шифрования отвергается без раскрытия значения: %s", (value) => {
      const issues = issuesOf({ ...validEnv(), SECRETS_ENCRYPTION_KEY: value });
      expect(issues).toHaveLength(1);
      expect(issues[0]).toContain("SECRETS_ENCRYPTION_KEY");
      if (value) expect(issues[0]).not.toContain(value);
    },
  );

  test("каталог фиктивной песочницы обязателен только в тестовом режиме", () => {
    expect(issuesOf({ ...validEnv(), FAKE_SANDBOX_DIR: undefined })[0]).toContain("FAKE_SANDBOX_DIR");
    expect(parseConfig({ ...productionEnv(), FAKE_SANDBOX_DIR: undefined }).fakeSandboxDir).toBeUndefined();
    expect(parseConfig({ ...validEnv(), FAKE_SANDBOX_DIR: "/tmp/custom-sandbox" }).fakeSandboxDir).toBe("/tmp/custom-sandbox");
  });

  test.each([
    ["SANDBOX_CPU", "0"], ["SANDBOX_CPU", "5"], ["SANDBOX_CPU", "1.5"],
    ["SANDBOX_MEMORY_GB", "2"], ["SANDBOX_MEMORY_GB", "9"],
    ["SANDBOX_DISK_GB", "0"], ["SANDBOX_DISK_GB", "11"],
    ["DAYTONA_API_URL", "not-url"], ["DAYTONA_API_URL", "ftp://example.com"],
  ])("неверное ограничение %s=%s отвергается", (name, value) => {
    expect(issuesOf({ ...validEnv(), [name]: value })[0]).toContain(name);
  });
});

/** Production-окружение без тестовых подмен. */
function productionEnv(): EnvRecord {
  const env = validEnv();
  delete env.APP_TEST_MODE;
  delete env.TEST_APP_PORT;
  delete env.NEXT_DIST_DIR;
  return {
    ...env,
    NODE_ENV: "production",
    APP_URL: "https://studio.example.com",
    TELEGRAM_CLIENT_ID: "123456789",
    TELEGRAM_CLIENT_SECRET: "test-client-secret",
    AGENT_MODEL: "openai/gpt-6-luna-fast",
  };
}

describe("parseConfig: модель агента", () => {
  test("в тестовом режиме AGENT_MODEL не нужна, рассуждение по умолчанию high", () => {
    const config = parseConfig(validEnv());

    expect(config.agentModel).toBeUndefined();
    expect(config.agentReasoning).toBe("high");
  });

  test("вне тестового режима без AGENT_MODEL ошибка называет переменную", () => {
    const env = productionEnv();
    delete env.AGENT_MODEL;

    const issues = issuesOf(env);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("AGENT_MODEL");
  });

  test("AGENT_MODEL_BASE_URL требует ключ и окно контекста", () => {
    const issues = issuesOf({
      ...productionEnv(),
      AGENT_MODEL_BASE_URL: "https://api.example.com/v1",
    });

    expect(issues).toHaveLength(2);
    expect(issues.join("\n")).toContain("AGENT_MODEL_API_KEY");
    expect(issues.join("\n")).toContain("AGENT_MODEL_CONTEXT_TOKENS");
  });

  test("окно контекста — целое число не меньше 8000", () => {
    expect(issuesOf({ ...productionEnv(), AGENT_MODEL_CONTEXT_TOKENS: "7999" })[0]).toContain(
      "AGENT_MODEL_CONTEXT_TOKENS",
    );
    expect(issuesOf({ ...productionEnv(), AGENT_MODEL_CONTEXT_TOKENS: "128000.5" })[0]).toContain(
      "AGENT_MODEL_CONTEXT_TOKENS",
    );
    expect(
      parseConfig({
        ...productionEnv(),
        AGENT_MODEL_BASE_URL: "https://api.example.com/v1",
        AGENT_MODEL_API_KEY: "ключ",
        AGENT_MODEL_CONTEXT_TOKENS: "128000",
      }).agentModelContextTokens,
    ).toBe(128000);
  });

  test("AGENT_REASONING принимает только известные уровни", () => {
    expect(issuesOf({ ...validEnv(), AGENT_REASONING: "максимум" })[0]).toContain(
      "AGENT_REASONING",
    );
    expect(parseConfig({ ...validEnv(), AGENT_REASONING: "xhigh" }).agentReasoning).toBe("xhigh");
  });
});

describe("parseConfig: вход через Telegram", () => {
  test("по умолчанию издатель oauth.telegram.org, срок 30 дней, dev-вход выключен", () => {
    const config = parseConfig(validEnv());

    expect(config.telegramOidcIssuer).toBe("https://oauth.telegram.org");
    expect(config.sessionTtlDays).toBe(30);
    expect(config.devLoginEnabled).toBe(false);
    expect(config.telegramClientId).toBeUndefined();
  });

  test.each(["TELEGRAM_CLIENT_ID", "TELEGRAM_CLIENT_SECRET"])("production без %s отвергается", (name) => {
    const env = productionEnv();
    delete env[name];

    const issues = issuesOf(env);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain(name);
  });

  test.each([
    { TELEGRAM_CLIENT_ID: "424242", missing: "TELEGRAM_CLIENT_SECRET" },
    { TELEGRAM_CLIENT_SECRET: "test-client-secret", missing: "TELEGRAM_CLIENT_ID" },
  ])("частичная настройка Telegram требует $missing", ({ missing, ...telegram }) => {
    const issues = issuesOf({ ...validEnv(), ...telegram });

    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain(missing);
  });

  test("SESSION_SECRET короче 32 символов отвергается", () => {
    const issues = issuesOf({ ...validEnv(), SESSION_SECRET: "короткий" });

    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("SESSION_SECRET");
  });

  test("SESSION_SECRET обязателен всегда", () => {
    const env = validEnv();
    delete env.SESSION_SECRET;

    expect(issuesOf(env)[0]).toContain("SESSION_SECRET");
  });

  test("пример SESSION_SECRET отвергается в production", () => {
    const issues = issuesOf({
      ...productionEnv(),
      SESSION_SECRET: "dev-only-session-secret-change-me-0123456789abcd",
    });

    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("SESSION_SECRET");
  });

  test("DEV_LOGIN_ENABLED=1 запрещён в production", () => {
    const issues = issuesOf({ ...productionEnv(), DEV_LOGIN_ENABLED: "1" });

    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("DEV_LOGIN_ENABLED");
  });

  test("DEV_LOGIN_ENABLED=1 запрещён на публичном хосте", () => {
    const issues = issuesOf({
      ...validEnv(),
      APP_URL: "https://app.example.com",
      DEV_LOGIN_ENABLED: "1",
    });

    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("DEV_LOGIN_ENABLED");

    for (const appUrl of ["http://localhost:3000", "http://127.0.0.1:3000", "http://[::1]:3000"]) {
      expect(() => parseConfig({ ...validEnv(), APP_URL: appUrl, DEV_LOGIN_ENABLED: "1" })).not.toThrow();
    }
  });

  test("издатель не на https:// запрещён без APP_TEST_MODE", () => {
    const env = validEnv();
    delete env.APP_TEST_MODE;
    const issues = issuesOf({
      ...env,
      AGENT_MODEL: "openai/gpt-6-luna-fast",
      TELEGRAM_OIDC_ISSUER: "http://localhost:59100",
    });

    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("TELEGRAM_OIDC_ISSUER");

    expect(() =>
      parseConfig({
        ...validEnv(),
        APP_TEST_MODE: "1",
        TELEGRAM_OIDC_ISSUER: "http://localhost:59100",
      }),
    ).not.toThrow();
  });

  test("TELEGRAM_OIDC_ISSUER не должен заканчиваться на /", () => {
    const issues = issuesOf({ ...validEnv(), TELEGRAM_OIDC_ISSUER: "https://oauth.telegram.org/" });

    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("TELEGRAM_OIDC_ISSUER");
  });

  test("TELEGRAM_CLIENT_ID состоит только из цифр", () => {
    const env = { ...validEnv(), TELEGRAM_CLIENT_ID: "abc" };

    expect(issuesOf(env)[0]).toContain("TELEGRAM_CLIENT_ID");
  });

  test("SESSION_TTL_DAYS принимает только целое от 1 до 365", () => {
    for (const value of ["0", "366", "1.5", "month"]) {
      expect(issuesOf({ ...validEnv(), SESSION_TTL_DAYS: value })[0]).toContain("SESSION_TTL_DAYS");
    }
    expect(parseConfig({ ...validEnv(), SESSION_TTL_DAYS: "1" }).sessionTtlDays).toBe(1);
    expect(parseConfig({ ...validEnv(), SESSION_TTL_DAYS: "365" }).sessionTtlDays).toBe(365);
  });

  test("адреса Edge TTS необязательны и принимают тестовый сервер", () => {
    expect(parseConfig(validEnv()).edgeTtsWssUrl).toBeUndefined();
    expect(parseConfig(validEnv()).edgeTtsVoicesUrl).toBeUndefined();
    expect(parseConfig({ ...validEnv(), EDGE_TTS_WSS_URL: "" }).edgeTtsWssUrl).toBeUndefined();
    expect(
      parseConfig({
        ...validEnv(),
        EDGE_TTS_WSS_URL: "ws://127.0.0.1:59101/tts",
        EDGE_TTS_VOICES_URL: "http://127.0.0.1:59101/voices",
      }),
    ).toMatchObject({
      edgeTtsWssUrl: "ws://127.0.0.1:59101/tts",
      edgeTtsVoicesUrl: "http://127.0.0.1:59101/voices",
    });
    expect(issuesOf({ ...validEnv(), EDGE_TTS_WSS_URL: "http://127.0.0.1:59101/tts" })[0]).toContain(
      "EDGE_TTS_WSS_URL",
    );
  });
});
