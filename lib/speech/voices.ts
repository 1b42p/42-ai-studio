import { voiceDisplayName, voiceIsMultilingual } from "./format";

export interface CatalogVoice {
  readonly name: string;
  readonly locale: string;
  readonly gender: string;
}

export interface ListedVoice {
  readonly name: string;
  readonly locale: string;
  readonly gender: string;
  readonly displayName: string;
  readonly multilingual: boolean;
}

export interface VoiceChoice {
  readonly voice: string;
  readonly language: string;
}

const DEFAULT_VOICES: Readonly<Record<string, string>> = {
  "ru-RU": "ru-RU-SvetlanaNeural",
  "en-US": "en-US-AvaNeural",
};

const LOCALE_IN_NAME = /^([a-z]{2,3}-[A-Z]{2})-/;

/** Локаль из короткого имени (`ru-RU-SvetlanaNeural` → `ru-RU`). */
export function localeFromVoiceName(name: string): string | null {
  return LOCALE_IN_NAME.exec(name)?.[1] ?? null;
}

/**
 * `ru` → `ru-RU`, `en` → `en-US`, `ru-ru` → `ru-RU`.
 * Другой голый язык остаётся кодом языка (`de`).
 */
export function normalizeLanguageInput(input: string): string {
  const match = /^([a-zA-Z]{2,3})(?:-([a-zA-Z]{2}))?$/.exec(input.trim());
  if (match === null) return input.trim();
  const language = match[1]?.toLowerCase() ?? "";
  const region = match[2];
  if (region === undefined) {
    if (language === "ru") return "ru-RU";
    if (language === "en") return "en-US";
    return language;
  }
  return `${language}-${region.toUpperCase()}`;
}

export function voiceChoiceNeedsCatalog(language: string, voice: string | undefined): boolean {
  if (voice !== undefined && voice.trim() !== "") return false;
  return DEFAULT_VOICES[normalizeLanguageInput(language)] === undefined;
}

function firstLocale(catalog: readonly CatalogVoice[], language: string): string | null {
  const prefix = `${language.toLowerCase()}-`;
  const locales = [...new Set(catalog.map((item) => item.locale))]
    .filter((locale) => locale.toLowerCase().startsWith(prefix))
    .sort((left, right) => left.localeCompare(right));
  return locales[0] ?? null;
}

/**
 * Явный голос не сверяется со списком: неизвестное имя отвергает сервис.
 * Без голоса: готовая пара для `ru-RU` и `en-US`, иначе первый по алфавиту
 * голос локали. Голый язык кроме `ru`/`en` — первая по алфавиту локаль этого языка.
 */
export function resolveVoiceChoice(
  input: { readonly voice?: string; readonly language: string },
  catalog: readonly CatalogVoice[],
): { readonly ok: true; readonly choice: VoiceChoice } | { readonly ok: false; readonly name: string } {
  const explicit = input.voice?.trim();
  if (explicit !== undefined && explicit !== "") {
    const language = localeFromVoiceName(explicit) ?? normalizeLanguageInput(input.language);
    return { ok: true, choice: { voice: explicit, language } };
  }

  const normalized = normalizeLanguageInput(input.language);
  const locale = normalized.includes("-") ? normalized : firstLocale(catalog, normalized);
  if (locale === null) return { ok: false, name: input.language };

  const preset = DEFAULT_VOICES[locale];
  if (preset !== undefined) return { ok: true, choice: { voice: preset, language: locale } };

  const voice = catalog
    .filter((item) => item.locale === locale)
    .map((item) => item.name)
    .sort((left, right) => left.localeCompare(right))[0];
  if (voice === undefined) return { ok: false, name: input.language };
  return { ok: true, choice: { voice, language: locale } };
}

function languageMatches(locale: string, language: string): boolean {
  const full = /^([a-zA-Z]{2,3})-([a-zA-Z]{2})$/.exec(language.trim());
  if (full !== null) {
    const wanted = `${full[1]?.toLowerCase()}-${full[2]?.toUpperCase()}`;
    return locale.toLowerCase() === wanted.toLowerCase();
  }
  const bare = language.trim().toLowerCase();
  const folded = locale.toLowerCase();
  return folded === bare || folded.startsWith(`${bare}-`);
}

export function toListedVoice(voice: CatalogVoice): ListedVoice {
  return {
    name: voice.name,
    locale: voice.locale,
    gender: voice.gender,
    displayName: voiceDisplayName(voice.name),
    multilingual: voiceIsMultilingual(voice.name),
  };
}

/** Пустой список дополняется `availableLocales` всего каталога. */
export function selectVoices(
  catalog: readonly CatalogVoice[],
  language: string,
  gender?: "Female" | "Male",
): { readonly voices: ListedVoice[]; readonly availableLocales?: readonly string[] } {
  let matched = catalog.filter((voice) => languageMatches(voice.locale, language));
  if (gender !== undefined) matched = matched.filter((voice) => voice.gender === gender);
  const voices = matched
    .map((voice) => toListedVoice(voice))
    .sort((left, right) => left.name.localeCompare(right.name));
  if (voices.length > 0) return { voices };
  const availableLocales = [...new Set(catalog.map((voice) => voice.locale))].sort((left, right) =>
    left.localeCompare(right),
  );
  return { voices, availableLocales };
}
