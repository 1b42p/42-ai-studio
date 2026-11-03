import { diffLines } from "diff";

import { contentLineCount } from "./line-counts";

/** Строк контекста вокруг каждого фрагмента изменений. */
export const DIFF_CONTEXT_LINES = 3;

/** Сколько строк diff показывать до кнопки «Показать все». */
export const DIFF_PREVIEW_LINES = 200;

/** Порог: при большем числе строк файла diff не рисуем. */
export const DIFF_TOO_LARGE_LINES = 4000;

export type DiffRow =
  | {
      readonly kind: "context" | "added" | "removed";
      readonly text: string;
      readonly oldLine: number | null;
      readonly newLine: number | null;
    }
  | {
      readonly kind: "skip";
      readonly skipped: number;
    };

interface FlatLine {
  readonly kind: "context" | "added" | "removed";
  readonly text: string;
  readonly oldLine: number | null;
  readonly newLine: number | null;
}

function splitChangeLines(value: string): string[] {
  if (value.length === 0) return [];
  const parts = value.split("\n");
  if (value.endsWith("\n")) parts.pop();
  return parts.map((line, index, list) =>
    index < list.length - 1 || value.endsWith("\n") ? `${line}\n` : line,
  );
}

/** Полный построчный diff без сжатия контекста. */
export function flattenDiffLines(oldContent: string, newContent: string): FlatLine[] {
  const rows: FlatLine[] = [];
  let oldLine = 1;
  let newLine = 1;
  for (const change of diffLines(oldContent, newContent)) {
    const lines = splitChangeLines(change.value);
    for (const text of lines) {
      if (change.added) {
        rows.push({ kind: "added", text, oldLine: null, newLine: newLine++ });
      } else if (change.removed) {
        rows.push({ kind: "removed", text, oldLine: oldLine++, newLine: null });
      } else {
        rows.push({ kind: "context", text, oldLine: oldLine++, newLine: newLine++ });
      }
    }
  }
  return rows;
}

/**
 * Diff с тремя строками контекста и маркерами «⋯ N строк без изменений»
 * между далёкими фрагментами.
 */
export function buildDiffRows(oldContent: string, newContent: string): DiffRow[] {
  const flat = flattenDiffLines(oldContent, newContent);
  if (flat.length === 0) return [];

  const changed = new Set<number>();
  for (let index = 0; index < flat.length; index += 1) {
    if (flat[index]!.kind !== "context") changed.add(index);
  }
  if (changed.size === 0) {
    return flat.map((row) => ({ ...row }));
  }

  const keep = new Array<boolean>(flat.length).fill(false);
  for (const index of changed) {
    const from = Math.max(0, index - DIFF_CONTEXT_LINES);
    const to = Math.min(flat.length - 1, index + DIFF_CONTEXT_LINES);
    for (let cursor = from; cursor <= to; cursor += 1) keep[cursor] = true;
  }

  const rows: DiffRow[] = [];
  let index = 0;
  while (index < flat.length) {
    if (keep[index]) {
      rows.push({ ...flat[index]! });
      index += 1;
      continue;
    }
    let end = index;
    while (end < flat.length && !keep[end]) end += 1;
    rows.push({ kind: "skip", skipped: end - index });
    index = end;
  }
  return rows;
}

export function isDiffTooLarge(oldContent: string, newContent: string): boolean {
  return Math.max(contentLineCount(oldContent), contentLineCount(newContent)) > DIFF_TOO_LARGE_LINES;
}
