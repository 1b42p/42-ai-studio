/**
 * Подписи голоса для карточки и списка.
 * Модуль без Node и без клиента Edge TTS: его импортирует браузер.
 */

const LOCALE_PREFIX = /^[a-z]{2,3}-[A-Z]{2}-/;

/** Короткое имя между локалью и `Neural`, без `Multilingual`. */
export function voiceDisplayName(name: string): string {
  return name
    .replace(LOCALE_PREFIX, "")
    .replaceAll("Multilingual", "")
    .replace(/NeuralHD$/, "")
    .replace(/Neural$/, "");
}

export function voiceIsMultilingual(name: string): boolean {
  return name.includes("Multilingual");
}

/** «русский», не «русский (Россия)»: берётся языковой подтег. */
export function languageLabel(locale: string): string {
  const subtag = locale.split("-")[0] ?? locale;
  if (subtag.length === 0) return locale;
  return new Intl.DisplayNames(["ru"], { type: "language" }).of(subtag) ?? subtag;
}

/** Длительность карточки: `м:сс`. */
export function formatClock(durationMs: number): string {
  const total = Math.max(0, Math.round(durationMs / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}
