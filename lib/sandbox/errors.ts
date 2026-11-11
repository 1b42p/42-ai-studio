const messages = {
  no_daytona_key: "Песочница недоступна: не настроен ключ Daytona. Сообщите оператору сервиса.",
  session_not_bound: "Не удалось найти сессию для песочницы. Обновите страницу и повторите.",
  sandbox_create_failed: "Не удалось создать песочницу. Попробуйте ещё раз чуть позже.",
  capacity_exhausted: "Сейчас все песочницы заняты. Попробуйте позже.",
  sandbox_queue_timeout: "Свободная песочница так и не появилась. Отправьте сообщение ещё раз чуть позже.",
  sandbox_wait_cancelled: "Ожидание песочницы остановлено.",
  sandbox_start_failed: "Не удалось запустить песочницу. Попробуйте ещё раз.",
  daytona_unavailable: "Daytona сейчас недоступна. Попробуйте позже.",
} as const;

export type SandboxErrorCode = keyof typeof messages;

export class StudioSandboxError extends Error {
  constructor(readonly code: SandboxErrorCode) {
    super(`${code}: ${messages[code]}`);
    this.name = "StudioSandboxError";
  }
}

export function errorStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const record = error as Record<string, unknown>;
  for (const field of ["statusCode", "status"] as const) {
    if (typeof record[field] === "number") return record[field];
  }
  if ("response" in error) return errorStatus(error.response);
  return undefined;
}

export function isMissingSandbox(error: unknown): boolean {
  return errorStatus(error) === 404;
}

export function sandboxFailure(error: unknown, fallback: SandboxErrorCode): StudioSandboxError {
  if (error instanceof StudioSandboxError) return error;
  const status = errorStatus(error);
  const network = error instanceof Error && /^(DaytonaConnection|DaytonaRateLimit)/.test(error.name);
  const code = status === 429 || (status !== undefined && status >= 500) || network
    ? "daytona_unavailable" : fallback;
  // Never pass SDK errors (including their message, headers or cause) to the logger or eve.
  console.error("[sandbox]", code, status ?? "transport");
  return new StudioSandboxError(code);
}
