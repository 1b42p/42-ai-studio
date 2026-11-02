/**
 * Пределы загрузки файлов пользователя (#9). Один файл ограничен
 * `UPLOAD_MAX_BYTES`, одно сообщение — десятью файлами и 4 ГиБ: столько
 * выдерживает диск песочницы по умолчанию.
 */

/** Подписанная ссылка на загрузку живёт 15 минут. */
export const UPLOAD_URL_TTL_SECONDS = 15 * 60;

/** Больше десяти файлов в одном сообщении не прикладывается. */
export const MAX_MESSAGE_FILES = 10;

/** Суммарный размер вложений одного сообщения: 4 ГиБ. */
export const MAX_MESSAGE_UPLOAD_BYTES = 4 * 1024 ** 3;

/** Текст отказа, когда файлов больше десяти. */
export const TOO_MANY_FILES_MESSAGE = "Можно прикрепить не больше 10 файлов к одному сообщению.";

/** Текст отказа, когда суммарный размер больше 4 ГиБ. */
export const MESSAGE_TOO_LARGE_MESSAGE = "Суммарный размер вложений не больше 4 ГиБ.";

/** Текст отказа загрузки, если сервер не объяснил причину. */
export const UPLOAD_FAILED_MESSAGE = "Не удалось загрузить файл";

const LIMIT_UNITS: ReadonlyArray<readonly [string, number]> = [
  ["ГиБ", 1024 ** 3],
  ["МиБ", 1024 ** 2],
  ["КиБ", 1024],
  ["Б", 1],
];

/**
 * Предел в тексте отказа: единица подбирается так, чтобы число было не меньше
 * единицы, округление — до одной цифры после запятой (запятая как разделитель),
 * нулевая дробь отбрасывается: 2147483648 → «2 ГиБ», 1572864 → «1,5 МиБ».
 */
export function formatUploadLimit(bytes: number): string {
  const [unit, size] = LIMIT_UNITS.find(([, value]) => bytes >= value) ?? LIMIT_UNITS[3]!;
  const value = bytes / size;
  const rounded = Math.round(value * 10) / 10;
  const formatted = new Intl.NumberFormat("ru-RU", {
    maximumFractionDigits: 1,
    useGrouping: false,
  }).format(rounded);
  return `${formatted} ${unit}`;
}
