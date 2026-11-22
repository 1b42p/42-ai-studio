import { diffLines } from "diff";

/** Строк контекста вокруг каждого фрагмента изменений. */
export const DIFF_CONTEXT_LINES = 3;

/** Сколько строк diff показывать до кнопки «Показать все». */
export const DIFF_PREVIEW_LINES = 200;

/** Предел строк в раскрытом diff, включая контекст и пропуски. */
const DIFF_MAX_ROWS = 4000;
const DIFF_TIMEOUT_MS = 50;

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

function tailOffset(value: string, lines: number): number {
  let offset = value.length - (value.endsWith("\n") ? 1 : 0);
  for (let line = 0; line < lines; line += 1) {
    offset = value.lastIndexOf("\n", offset - 1);
  }
  return offset + 1;
}

/**
 * Diff с тремя строками контекста. Длинные неизменённые участки не
 * разворачиваются в строки; null означает, что исчерпан лимит показа.
 */
export function buildDiffRows(oldContent: string, newContent: string): DiffRow[] | null {
  const changes = diffLines(oldContent, newContent, {
    maxEditLength: DIFF_MAX_ROWS,
    timeout: DIFF_TIMEOUT_MS,
  });
  if (!changes) return null;

  const rows: DiffRow[] = [];
  let oldLine = 1;
  let newLine = 1;
  for (const [index, { added, removed, count, value }] of changes.entries()) {
    const kind = added ? "added" : removed ? "removed" : "context";
    let head = count;
    let tail = 0;
    if (kind === "context" && changes.length > 1) {
      head = index > 0 ? Math.min(count, DIFF_CONTEXT_LINES) : 0;
      tail = index < changes.length - 1 ? Math.min(count - head, DIFF_CONTEXT_LINES) : 0;
    }
    const skipped = count - head - tail;
    if (rows.length + head + tail + Number(skipped > 0) > DIFF_MAX_ROWS) return null;

    function appendLines(from: number, length: number) {
      let offset = from;
      for (let line = 0; line < length; line += 1) {
        const newline = value.indexOf("\n", offset);
        const end = newline === -1 ? value.length : newline + 1;
        rows.push({
          kind,
          text: value.slice(offset, end),
          oldLine: added ? null : oldLine++,
          newLine: removed ? null : newLine++,
        });
        offset = end;
      }
      return offset;
    }

    const headEnd = appendLines(0, head);
    if (skipped > 0) {
      rows.push({ kind: "skip", skipped });
      oldLine += skipped;
      newLine += skipped;
    }
    if (tail > 0) appendLines(skipped > 0 ? tailOffset(value, tail) : headEnd, tail);
  }
  return rows;
}
