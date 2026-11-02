import { EditFileError } from "./errors";
import { countLineChanges } from "./line-counts";

/** Предел размера файла до и после правки (256 КиБ). */
export const EDIT_FILE_MAX_BYTES = 262_144;

export interface EditFileApplyInput {
  readonly oldString?: string;
  readonly newString: string;
  readonly replaceAll?: boolean;
  readonly overwrite?: boolean;
}

export interface EditFileApplyResult {
  readonly created: boolean;
  readonly replacements: number;
  readonly oldContent: string | null;
  readonly newContent: string;
  readonly linesAdded: number;
  readonly linesRemoved: number;
}

/** Число непересекающихся вхождений `needle` в `haystack`. */
export function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let position = 0;
  while (position <= haystack.length - needle.length) {
    const index = haystack.indexOf(needle, position);
    if (index === -1) break;
    count += 1;
    position = index + needle.length;
  }
  return count;
}

function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

/**
 * Чистая правка содержимого: без песочницы. `existing` — `null`, если файла нет;
 * пустая строка — пустой файл. Путь нужен только для текстов ошибок.
 */
export function applyEditFile(
  path: string,
  existing: string | null,
  input: EditFileApplyInput,
): EditFileApplyResult {
  const newString = input.newString;
  const replaceAll = input.replaceAll === true;
  const overwrite = input.overwrite === true;
  // Пустой или отсутствующий oldString — создание/перезапись; явный пустой
  // oldString при пустом newString — no_change (оба пусты).
  const createMode = input.oldString === undefined || input.oldString.length === 0;
  const oldString = input.oldString ?? "";

  if (input.oldString !== undefined && input.oldString === newString) {
    throw new EditFileError("no_change");
  }

  if (createMode) {
    if (existing === null) {
      if (utf8ByteLength(newString) > EDIT_FILE_MAX_BYTES) {
        throw new EditFileError("too_large", path);
      }
      const { linesAdded, linesRemoved } = countLineChanges("", newString);
      return {
        created: true,
        replacements: 0,
        oldContent: null,
        newContent: newString,
        linesAdded,
        linesRemoved,
      };
    }
    if (existing.length > 0 && !overwrite) {
      throw new EditFileError("exists", path);
    }
    if (utf8ByteLength(newString) > EDIT_FILE_MAX_BYTES) {
      throw new EditFileError("too_large", path);
    }
    const { linesAdded, linesRemoved } = countLineChanges(existing, newString);
    return {
      created: false,
      replacements: 0,
      oldContent: existing,
      newContent: newString,
      linesAdded,
      linesRemoved,
    };
  }

  if (existing === null) {
    throw new EditFileError("not_found", path);
  }

  const occurrences = countOccurrences(existing, oldString);
  if (occurrences === 0) {
    throw new EditFileError("fragment_not_found", path);
  }
  if (occurrences > 1 && !replaceAll) {
    throw new EditFileError("ambiguous", path, occurrences);
  }

  const newContent = replaceAll
    ? existing.replaceAll(oldString, newString)
    : existing.replace(oldString, newString);

  if (utf8ByteLength(newContent) > EDIT_FILE_MAX_BYTES) {
    throw new EditFileError("too_large", path);
  }

  const { linesAdded, linesRemoved } = countLineChanges(existing, newContent);
  return {
    created: false,
    replacements: replaceAll ? occurrences : 1,
    oldContent: existing,
    newContent,
    linesAdded,
    linesRemoved,
  };
}

/** Короткий текст для модели: без содержимого файла. */
export function formatEditFileModelOutput(result: {
  readonly path: string;
  readonly created: boolean;
  readonly replacements: number;
  readonly linesAdded: number;
  readonly linesRemoved: number;
}): string {
  const verb = result.created ? "создан" : "изменён";
  return `Файл ${result.path} ${verb}: замен ${result.replacements}, добавлено ${result.linesAdded} и удалено ${result.linesRemoved} строк.`;
}
