import { EdgeTTSError } from "@andresaya/edge-tts";

const MESSAGES = {
  speak_unavailable:
    "Сервис озвучки сейчас недоступен (после трёх попыток). Повторите позже или озвучьте запасным способом. Установите Piper в песочнице и озвучьте им этот текст.",
  speak_rate_limited:
    "Сервис озвучки ограничил частоту запросов (после трёх попыток). Подождите минуту и повторите. Если повтор тоже завершится этой ошибкой, установите Piper в песочнице и озвучьте им.",
  speak_bad_input: "Текст пуст или содержит только пробелы.",
  speak_publish_failed: "Озвучка записана в песочницу, но не сохранена для просмотра. Повторите.",
  voices_unavailable: "Список голосов сейчас недоступен. Повторите позже.",
  speak_text_not_readable:
    "Выбранный голос не прочитал значительную часть текста: вероятно, язык текста не совпадает с языком голоса. Выберите голос нужного языка или многоязычный.",
  speak_no_session: "Не удалось определить сессию для сохранения озвучки.",
} as const;

export type SpeechErrorCode = keyof typeof MESSAGES;

const RETRYABLE_NODE_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "ECONNRESET",
  "ETIMEDOUT",
  "EAI_AGAIN",
]);

/** Обрыв звука без `turn.end`: повтор, как недоступность сервиса. */
export class SpeechIncompleteError extends Error {
  constructor() {
    super("speech incomplete");
    this.name = "SpeechIncompleteError";
  }
}

export function speechError(code: SpeechErrorCode): Error {
  return new Error(`${code}: ${MESSAGES[code]}`);
}

export function speakVoiceNotFound(name: string): string {
  return `speak_voice_not_found: Голос «${name}» не найден. Список голосов даёт инструмент list_voices.`;
}

export function speakBadPath(path: string): string {
  return `speak_bad_path: Путь «${path}» выходит за пределы рабочей области.`;
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function nodeCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = error.code;
  return typeof code === "string" ? code : undefined;
}

export function isRetryableNodeError(error: unknown): boolean {
  const code = nodeCode(error);
  return code !== undefined && RETRYABLE_NODE_CODES.has(code);
}

/** Повтор: 429, 5xx, таймаут, обрыв и сетевые коды Node. Отказ, 401/403 и отмена — нет. */
export function isRetryableSpeechError(error: unknown): boolean {
  if (isAbortError(error)) return false;
  if (error instanceof SpeechIncompleteError) return true;
  if (error instanceof Error && /^speak_|^voices_/.test(error.message)) return false;
  if (error instanceof EdgeTTSError) {
    if (error.code === "TIMEOUT") return true;
    if (error.code !== "HANDSHAKE") return false;
    const status = error.status;
    return status === 429 || (status !== undefined && status >= 500);
  }
  return isRetryableNodeError(error);
}

/**
 * Текст для модели. Сообщение библиотеки (адрес, `ECONNREFUSED`) наружу не попадает.
 */
export function mapSpeechFailure(
  error: unknown,
  options: { readonly voiceExplicit: boolean; readonly voiceName: string },
): Error {
  if (isAbortError(error)) return error as Error;
  if (error instanceof Error && /^speak_|^voices_/.test(error.message)) return error;
  if (error instanceof SpeechIncompleteError) return speechError("speak_unavailable");
  if (error instanceof EdgeTTSError) {
    if (error.code === "HANDSHAKE" && error.status === 429) return speechError("speak_rate_limited");
    if (error.code === "REFUSED") {
      return options.voiceExplicit
        ? new Error(speakVoiceNotFound(options.voiceName))
        : speechError("speak_unavailable");
    }
    if (error.code === "NO_AUDIO") return speechError("speak_text_not_readable");
    if (error.code === "INVALID_OPTION") return speechError("speak_bad_input");
    if (error.code === "VOICES") return speechError("voices_unavailable");
    return speechError("speak_unavailable");
  }
  return speechError("speak_unavailable");
}

/** В журнал — только код библиотеки и статус, без текста исключения. */
export function logSpeechFailure(error: unknown): void {
  if (error instanceof SpeechIncompleteError) {
    console.error("edge-tts incomplete");
    return;
  }
  if (error instanceof EdgeTTSError) {
    const status = error.status === undefined ? "" : ` ${error.status}`;
    console.error(`edge-tts ${error.code}${status}`);
    return;
  }
  const code = nodeCode(error);
  console.error(code === undefined ? "edge-tts unknown" : `edge-tts ${code}`);
}
