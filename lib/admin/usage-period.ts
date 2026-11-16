const DAY_MS = 86_400_000;

/** Календарная дата отчёта: строгий YYYY-MM-DD, годы 0001–9999. */
export function validUsageDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith("0000-")) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** Обе границы включены; период содержит от 1 до 366 календарных дней. */
export function validUsageDates(from: string, to: string): boolean {
  if (!validUsageDate(from) || !validUsageDate(to)) return false;
  const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS + 1;
  return days >= 1 && days <= 366;
}
