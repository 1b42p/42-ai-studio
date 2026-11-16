/**
 * Публичный вид ключа Daytona для админки. Секрета и шифротекста здесь нет:
 * сериализатор отдаёт только эти поля.
 */
import type { KeyUsage } from "@/lib/daytona/usage";

export interface AdminKeyDefaults {
  readonly cpu: number;
  readonly memoryGb: number;
  readonly diskGb: number;
}

export interface AdminKeySandboxes {
  readonly running: number;
  readonly stopped: number;
  readonly archived: number;
}

export interface AdminKeyView {
  readonly id: string;
  readonly label: string;
  readonly enabled: boolean;
  readonly deletedAt: string | null;
  readonly createdAt: string;
  readonly order: number | null;
  readonly usage: KeyUsage | null;
  readonly usageCheckedAt: string | null;
  readonly exhaustedUntil: string | null;
  readonly remainingSandboxes: number | null;
  readonly fits: number | null;
  readonly sandboxes: AdminKeySandboxes;
  readonly warning: string | null;
}

export interface AdminKeysPage {
  readonly items: readonly AdminKeyView[];
  readonly defaults: AdminKeyDefaults;
}

export const KEY_REJECTED_MESSAGE =
  "Daytona не приняла ключ. Проверьте, что ключ скопирован целиком.";
export const KEY_UNAVAILABLE_MESSAGE =
  "Не удалось проверить ключ: Daytona недоступна. Попробуйте позже.";
export const KEY_LABEL_CONFLICT_MESSAGE = "Ключ с таким названием уже есть.";
export const KEY_SECRET_CONFLICT_MESSAGE = "Такой ключ уже добавлен.";
export const KEY_DELETED_MESSAGE = "Ключ удалён.";
export const KEY_VALIDATION_MESSAGE =
  "Укажите название от 1 до 60 символов и ключ от 8 до 512 символов без пробелов.";

export const USAGE_ERROR_TEXT = {
  unauthorized:
    "Daytona не приняла ключ при чтении квот. Ключ мог быть отозван или истечь; проверьте его в панели Daytona.",
  forbidden:
    "У ключа нет права читать квоты. Нужно право `write:sandboxes` или `read:billing` (страница прав Daytona: маршруты «usage and cost»). Показаны последние известные данные.",
  unavailable: "Daytona сейчас недоступна. Показаны последние известные данные.",
  unexpected: "Ответ Daytona не удалось разобрать. Показаны последние известные данные.",
} as const;

export const USAGE_ERROR_SUFFIX =
  "Пока квоты недоступны, ключ считается подходящим для новых песочниц.";

export function quotaShareWarning(otherLabel: string): string {
  return `Ключи одной организации Daytona делят одну квоту («${otherLabel}»).`;
}

export function remainingSandboxesWarning(count: number): string {
  return `Ключ удалён, но ${count} ${ruPlural(count, "песочницу", "песочницы", "песочниц")} не удалось удалить в Daytona. Удалите их в панели Daytona: они занимают квоту организации.`;
}

export function ruPlural(count: number, one: string, few: string, many: string): string {
  const abs = Math.abs(count) % 100;
  const last = abs % 10;
  if (abs > 10 && abs < 20) return many;
  if (last === 1) return one;
  if (last >= 2 && last <= 4) return few;
  return many;
}

/** Название сравнивается без учёта регистра в приложении, не в базе. */
export function labelKey(label: string): string {
  return label.trim().toLocaleLowerCase("ru-RU");
}

export function isValidKeyLabel(label: string): boolean {
  const trimmed = label.trim();
  return trimmed.length >= 1 && trimmed.length <= 60;
}

export function isValidApiKey(apiKey: string): boolean {
  return apiKey.length >= 8 && apiKey.length <= 512 && !/[\s\p{Cc}]/u.test(apiKey);
}
