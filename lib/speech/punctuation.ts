const OPENING = "([{«“‘¿¡";
const CLOSING = ".,;:!?…)]}»”’%";

function isSpace(char: string | undefined): boolean {
  return char === " " || char === "\t";
}

/** Переводы строк — пробелы, длина строки не меняется, индексы совпадают. */
function normalizeBreaks(text: string): string {
  return text.replace(/[\n\r]/g, " ");
}

/** Ключ поиска с неизменными индексами UTF-16. */
function matchKey(text: string): string {
  return text.replace(/\p{L}/gu, (letter) => {
    const folded = letter.toLowerCase().replace("ё", "е");
    return folded.length === letter.length ? folded : letter;
  });
}

function attachesToNext(char: string, spaceBefore: boolean, spaceAfter: boolean): boolean {
  if (char === '"' || char === "'") return spaceBefore;
  if (char === "—" || char === "–") return false;
  if (OPENING.includes(char) && !spaceAfter) return true;
  if (CLOSING.includes(char) && !spaceBefore) return false;
  if (spaceBefore && spaceAfter) return false;
  if (OPENING.includes(char)) return true;
  return false;
}

/** Пробелы пропускаются. Знак с пробелом перед ним приклеивается к предыдущей единице через пробел. */
function splitGap(
  source: string,
  gapStart: number,
  gap: string,
): { prefix: string; suffix: string } {
  let prefix = "";
  let suffix = "";
  for (let index = 0; index < gap.length; index++) {
    const char = gap[index] ?? "";
    if (isSpace(char)) continue;
    const position = gapStart + index;
    const spaceBefore = position === 0 || isSpace(source[position - 1]);
    const spaceAfter = position === source.length - 1 || isSpace(source[position + 1]);
    if (attachesToNext(char, spaceBefore, spaceAfter)) {
      prefix += char;
      continue;
    }
    suffix += spaceBefore && !suffix.endsWith(" ") ? ` ${char}` : char;
  }
  return { prefix, suffix };
}

/**
 * Возвращает знаки препинания к единицам речи сервиса.
 * Если границы не удаётся привязать к исходнику, оставляет текст сервиса.
 */
export function attachPunctuation(source: string, units: readonly string[]): string[] {
  const text = normalizeBreaks(source.normalize("NFC"));
  const matches = matchKey(text);
  const out = [...units];
  let cursor = 0;
  let previous: number | null = null;

  for (let index = 0; index < units.length; index++) {
    const unit = normalizeBreaks((units[index] ?? "").normalize("NFC"));
    if (unit.length === 0) continue;
    const found = matches.indexOf(matchKey(unit), cursor);
    if (found === -1) return [...units];

    const { prefix, suffix } = splitGap(text, cursor, text.slice(cursor, found));
    if (suffix !== "" && previous !== null) out[previous] += suffix;
    const leading = suffix !== "" && previous === null ? suffix : "";
    cursor = found + unit.length;
    out[index] = leading + prefix + text.slice(found, cursor);
    previous = index;
  }

  if (previous !== null && cursor < text.length) {
    const { prefix, suffix } = splitGap(text, cursor, text.slice(cursor));
    out[previous] += suffix + prefix;
  }
  return out;
}
