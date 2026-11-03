/** Коды ошибок инструмента `edit_file` в порядке приоритета проверок. */
export type EditFileErrorCode =
  | "bad_path"
  | "is_directory"
  | "not_found"
  | "too_large"
  | "not_text"
  | "no_change"
  | "fragment_not_found"
  | "ambiguous"
  | "exists";

const messages = {
  bad_path: () =>
    "Путь не поддерживается: укажи абсолютный путь или путь от /workspace.",
  is_directory: (path: string) => `${path} — это каталог.`,
  not_found: (path: string) =>
    `Файл ${path} не найден. Чтобы создать файл, не указывай oldString.`,
  too_large: (path: string) => `Файл ${path} больше 256 КиБ: изменяй его командой.`,
  not_text: (path: string) => `Файл ${path} не текстовый.`,
  no_change: () => "oldString и newString совпадают: менять нечего.",
  fragment_not_found: (path: string) =>
    `Фрагмент не найден в ${path}. Сравнение точное: проверь пробелы, отступы и переводы строк.`,
  ambiguous: (path: string, count: number) =>
    `Фрагмент встречается в ${path} ${count} раз. Добавь соседние строки, чтобы он стал уникальным, или передай replaceAll: true.`,
  exists: (path: string) =>
    `Файл ${path} уже существует и не пуст. Укажи oldString для замены или передай overwrite: true.`,
} as const;

export class EditFileError extends Error {
  readonly code: EditFileErrorCode;

  constructor(code: EditFileErrorCode, path = "", count = 0) {
    const message =
      code === "ambiguous"
        ? messages.ambiguous(path, count)
        : code === "bad_path" || code === "no_change"
          ? messages[code]()
          : messages[code](path);
    super(message);
    this.name = "EditFileError";
    this.code = code;
  }
}

export function editFileErrorMessage(
  code: EditFileErrorCode,
  path = "",
  count = 0,
): string {
  return new EditFileError(code, path, count).message;
}
