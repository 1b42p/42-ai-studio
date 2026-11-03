/** Буквы Unicode (`\p{L}`). Регистр и `ё`/`е` на число не влияют: оба символа — буквы. */
function letterCount(text: string): number {
  return text.match(/\p{L}/gu)?.length ?? 0;
}

export type TextCoverage = "ok" | "unreadable" | "skipped";

/**
 * Доля букв в границах слов к буквам исходного текста.
 * Нет границ слов — текст не прочитан, даже если букв в нём нет.
 * Букв в исходном тексте нет — проверку доли пропускаем.
 */
export function textCoverage(source: string, wordTexts: readonly string[]): TextCoverage {
  if (wordTexts.length === 0) return "unreadable";
  const sourceLetters = letterCount(source);
  if (sourceLetters === 0) return "skipped";
  const read = wordTexts.reduce((sum, text) => sum + letterCount(text), 0);
  return read / sourceLetters >= 0.8 ? "ok" : "unreadable";
}
