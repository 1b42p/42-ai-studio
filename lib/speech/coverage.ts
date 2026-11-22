function spokenCharacters(text: string): string {
  return text.normalize("NFC").toLowerCase().replaceAll("ё", "е").replace(/[^\p{L}\p{N}\p{M}]/gu, "");
}

export type TextCoverage = "ok" | "unreadable";

/**
 * Сверяет порядок знаков речи, допуская разное разбиение слов в метаданных.
 * Доля прочитанных букв не годится: легко потерять короткое «не» или число.
 */
export function textCoverage(source: string, wordTexts: readonly string[]): TextCoverage {
  const spoken = spokenCharacters(wordTexts.join(" "));
  return spoken.length > 0 && spoken === spokenCharacters(source) ? "ok" : "unreadable";
}
