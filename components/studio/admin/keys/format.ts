import type { AdminKeyDefaults, AdminKeyView } from "@/lib/admin/key-view";
import { ruPlural } from "@/lib/admin/key-view";

export function amountLabel(title: string, used: number, quota: number, unit: string): string {
  const suffix = unit.length === 0 ? "" : ` ${unit}`;
  return `${title}: ${used} из ${quota}${suffix}`;
}

export function fitsLabel(fits: number, defaults: AdminKeyDefaults): string {
  const word = ruPlural(fits, "песочница", "песочницы", "песочниц");
  return `Ещё поместится: ${fits} ${word} (${defaults.cpu} vCPU / ${defaults.memoryGb} ГиБ / ${defaults.diskGb} ГиБ)`;
}

export function sandboxesLabel(key: AdminKeyView): string {
  const { running, stopped, archived } = key.sandboxes;
  return `Песочницы на ключе: запущено ${running}, остановлено ${stopped}, в архиве ${archived}`;
}

export function quotaLevel(used: number, quota: number): "ok" | "warning" | "destructive" {
  if (quota <= 0) return "destructive";
  const ratio = used / quota;
  if (ratio >= 0.9) return "destructive";
  if (ratio >= 0.7) return "warning";
  return "ok";
}

export function relativeTime(from: Date, now: Date): string {
  const minutes = Math.max(0, Math.floor((now.getTime() - from.getTime()) / 60_000));
  if (minutes < 1) return "только что";
  if (minutes < 60) return `${minutes} мин назад`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ч назад`;
  return `${Math.floor(hours / 24)} дн назад`;
}

export function clockTime(value: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("ru-RU", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone,
  }).format(value);
}
