import { diffLines } from "diff";

/** Число строк в тексте по правилам `diffLines` (символ `\n`). */
export function contentLineCount(text: string): number {
  if (text.length === 0) return 0;
  let count = 0;
  let index = 0;
  while (index < text.length) {
    const next = text.indexOf("\n", index);
    if (next === -1) {
      count += 1;
      break;
    }
    count += 1;
    index = next + 1;
  }
  return count;
}

/**
 * Счётчики добавленных и удалённых строк через `diffLines` без
 * `ignoreWhitespace`. Пример: «a» → «a\\n» даёт +1 −1.
 */
export function countLineChanges(oldContent: string, newContent: string): {
  readonly linesAdded: number;
  readonly linesRemoved: number;
} {
  let linesAdded = 0;
  let linesRemoved = 0;
  for (const change of diffLines(oldContent, newContent)) {
    const count = change.count ?? 0;
    if (change.added) linesAdded += count;
    else if (change.removed) linesRemoved += count;
  }
  return { linesAdded, linesRemoved };
}
