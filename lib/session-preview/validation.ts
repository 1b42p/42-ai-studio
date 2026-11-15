import { resolveSandboxFilePath } from "../media/sandbox-path";

export const PREVIEW_MAX_BYTES = 1_048_576;
export type PreviewContentType = "image/png" | "image/jpeg" | "image/webp";

export function previewSizeAllowed(size: number): boolean {
  return Number.isSafeInteger(size) && size >= 0 && size <= PREVIEW_MAX_BYTES;
}

export function previewPath(path: string): string | null {
  // Процентное кодирование не раскрывается при доступе к файлу. Однако
  // закодированную навигацию также не принимаем, чтобы нормализация входа
  // не могла превратить отвергнутый путь в допустимый.
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    decoded = path;
  }
  if ([path, decoded].some((value) => value.split("/").includes(".."))) return null;
  const resolved = resolveSandboxFilePath(path);
  return resolved.kind === "file" ? resolved.path : null;
}

/** Сигнатуры форматов, а не расширение, определяют Content-Type. */
export function previewContentType(bytes: Uint8Array): PreviewContentType | null {
  const starts = (signature: readonly number[], offset = 0) =>
    signature.every((byte, index) => bytes[offset + index] === byte);
  if (starts([137, 80, 78, 71, 13, 10, 26, 10])) return "image/png";
  if (starts([255, 216, 255])) return "image/jpeg";
  if (bytes.length >= 12 && starts([82, 73, 70, 70]) && starts([87, 69, 66, 80], 8)) {
    return "image/webp";
  }
  return null;
}
