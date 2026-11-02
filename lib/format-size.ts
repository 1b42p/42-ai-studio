/** Размер файла для человека: «2 КБ», «1,5 МБ». Общий для карточек файлов. */
export function formatFileSize(bytes: number | null): string {
  if (bytes === null) return "";
  const units = ["Б", "КБ", "МБ", "ГБ"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const formatted = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 }).format(value);
  return `${formatted} ${units[unit]}`;
}
