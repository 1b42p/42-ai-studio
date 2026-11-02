/**
 * Имена загружаемых файлов (#9). Косые черты, обратные косые, управляющие
 * символы и `..` в ключе S3 заменяются на `_`: имя не должно менять каталог
 * объекта. В ключе имя усекается до 180 байт с сохранением расширения и по
 * границе символа UTF-8, в `original_name` — до 255 символов.
 */

const UNSAFE_NAME = /\.\.|[\\/\u0000-\u001f\u007f-\u009f]/g;
const KEY_NAME_MAX_BYTES = 180;
const ORIGINAL_NAME_MAX_CHARS = 255;

const encoder = new TextEncoder();

function byteLength(value: string): number {
  return encoder.encode(value).length;
}

/** Строка не длиннее `maxBytes` в UTF-8 без разрезания символа. */
function truncateBytes(value: string, maxBytes: number): string {
  if (byteLength(value) <= maxBytes) return value;
  let result = "";
  let used = 0;
  for (const char of value) {
    const size = byteLength(char);
    if (used + size > maxBytes) break;
    result += char;
    used += size;
  }
  return result;
}

function cleaned(name: string): string {
  return name.replace(UNSAFE_NAME, "_").trim();
}

/** Имя в ключе объекта: до 180 байт, расширение по возможности сохранено. */
export function uploadKeyName(name: string): string {
  const base = cleaned(name);
  if (base.length === 0 || base === ".") return "file";
  if (byteLength(base) <= KEY_NAME_MAX_BYTES) return base;

  const dot = base.lastIndexOf(".");
  const extension = dot > 0 ? base.slice(dot) : "";
  const extensionBytes = byteLength(extension);
  if (extension.length > 0 && extensionBytes <= KEY_NAME_MAX_BYTES) {
    const stem = truncateBytes(base.slice(0, dot), KEY_NAME_MAX_BYTES - extensionBytes);
    if (stem.length > 0) return `${stem}${extension}`;
  }
  return truncateBytes(base, KEY_NAME_MAX_BYTES);
}

/** Имя для показа и скачивания: без косых и управляющих символов, до 255. */
export function uploadOriginalName(name: string): string {
  const base = cleaned(name);
  if (base.length === 0) return "file";
  return [...base].slice(0, ORIGINAL_NAME_MAX_CHARS).join("");
}
