import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";

/** Координаты шага Eve; также идентификатор файлов старых сообщений. */
export function messageIdOf(
  turnId: string | undefined,
  stepIndex: number | undefined,
): string | undefined {
  if (turnId === undefined || stepIndex === undefined) return undefined;
  return `${turnId}:${stepIndex}`;
}

/** Незавершённый шаг Eve может выдать другой текст под теми же координатами. */
export function messageFileId(stepId: string, text: string): string {
  // Журнал Postgres удаляет NUL из событий; живой и сохранённый поток
  // должны вычислять один ключ. Тот же ответ при повторе делит один снимок.
  return `${stepId}:${bytesToHex(sha256(text.replaceAll("\0", "")))}`;
}
