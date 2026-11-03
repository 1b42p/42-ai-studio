const OPENING = "([{«“‘¿¡";
const CLOSING = ".,;:!?…)]}»”’%";

function isSpace(char: string | undefined): boolean {
  return char === " " || char === "\t";
}

/** Переводы строк — пробелы, длина строки не меняется, индексы совпадают. */
function normalizeBreaks(text: string): string {
  return text.replace(/[\n\r]/g, " ");
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
 * Единицу, которой нет в исходном тексте, оставляет как пришла.
 */
export function attachPunctuation(source: string, units: readonly string[]): string[] {
  const text = normalizeBreaks(source);
  const out = [...units];
  let cursor = 0;
  let previous: number | null = null;

  for (let index = 0; index < units.length; index++) {
    const unit = units[index] ?? "";
    if (unit.length === 0) continue;
    const found = text.indexOf(unit, cursor);
    if (found === -1) continue;

    const { prefix, suffix } = splitGap(text, cursor, text.slice(cursor, found));
    if (suffix !== "" && previous !== null) out[previous] += suffix;
    const leading = suffix !== "" && previous === null ? suffix : "";
    out[index] = leading + prefix + unit;
    cursor = found + unit.length;
    previous = index;
  }

  if (previous !== null && cursor < text.length) {
    const { prefix, suffix } = splitGap(text, cursor, text.slice(cursor));
    out[previous] += suffix + prefix;
  }
  return out;
}
