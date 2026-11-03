import { EdgeTTS } from "@andresaya/edge-tts";

import { loadConfig } from "@/lib/config";

/** Единственный формат: у mp3 96 кбит/с длительность считается по размеру файла. */
export const SPEECH_OUTPUT_FORMAT = "audio-24khz-96kbitrate-mono-mp3";

/** Таймаут без данных, как у библиотеки по умолчанию. */
export const SPEECH_TIMEOUT_MS = 30_000;

let client: EdgeTTS | undefined;
let key = "";

/**
 * Один клиент на процесс: список голосов библиотека кэширует на 10 минут.
 * Пустые адреса не передаются, чтобы библиотека взяла свои.
 */
export function edgeTtsClient(): EdgeTTS {
  const config = loadConfig();
  const next = `${config.edgeTtsWssUrl ?? ""}\0${config.edgeTtsVoicesUrl ?? ""}`;
  if (client === undefined || key !== next) {
    client = new EdgeTTS({
      ...(config.edgeTtsWssUrl === undefined ? {} : { wssUrl: config.edgeTtsWssUrl }),
      ...(config.edgeTtsVoicesUrl === undefined ? {} : { voicesUrl: config.edgeTtsVoicesUrl }),
      timeout: SPEECH_TIMEOUT_MS,
    });
    key = next;
  }
  return client;
}
