/**
 * Разбор тела `POST /api/uploads` (#9): поля проверяются до обращения к базе.
 * Тип содержимого нормализуется: нижний регистр, без параметров после `;`,
 * пустой — поток байтов.
 */

export interface UploadRequest {
  readonly appSessionId: string;
  readonly name: string;
  readonly contentType: string;
  readonly sizeBytes: number;
}

export type ParsedUploadRequest =
  | { readonly ok: true; readonly value: UploadRequest }
  | { readonly ok: false; readonly kind: "invalid" }
  | { readonly ok: false; readonly kind: "too_large"; readonly name: string };

const CONTENT_TYPE =
  /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;

const MAX_CONTENT_TYPE_LENGTH = 127;
const MAX_NAME_LENGTH = 255;

/** Длина строки в символах, а не в единицах UTF-16. */
function characterLength(value: string): number {
  return [...value].length;
}

/**
 * Нормализованный MIME-тип или `null`, если строка не годится. Пустое
 * значение — `application/octet-stream`, `Text/Plain; charset=utf-8` —
 * `text/plain`.
 */
export function normalizeContentType(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const bare = raw.split(";")[0]?.trim().toLowerCase() ?? "";
  const value = bare.length === 0 ? "application/octet-stream" : bare;
  if (value.length > MAX_CONTENT_TYPE_LENGTH || !CONTENT_TYPE.test(value)) return null;
  return value;
}

/** Поля запроса или причина отказа; предел размера приходит из конфигурации. */
export function parseUploadRequest(input: unknown, maxBytes: number): ParsedUploadRequest {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, kind: "invalid" };
  }

  const body = input as Record<string, unknown>;
  const appSessionId = body.appSessionId;
  const name = body.name;
  const contentType = normalizeContentType(body.contentType);
  const sizeBytes = body.sizeBytes;

  if (typeof appSessionId !== "string" || appSessionId.length === 0) {
    return { ok: false, kind: "invalid" };
  }
  if (
    typeof name !== "string" ||
    name.length === 0 ||
    characterLength(name) > MAX_NAME_LENGTH
  ) {
    return { ok: false, kind: "invalid" };
  }
  if (contentType === null) return { ok: false, kind: "invalid" };
  if (typeof sizeBytes !== "number" || !Number.isInteger(sizeBytes) || sizeBytes < 1) {
    return { ok: false, kind: "invalid" };
  }
  if (sizeBytes > maxBytes) return { ok: false, kind: "too_large", name };

  return { ok: true, value: { appSessionId, name, contentType, sizeBytes } };
}
