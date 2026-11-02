/**
 * Адреса загруженных файлов (#9): `GET /api/media/<uuid>`. Сервер узнаёт свой
 * адрес по источнику и шаблону пути, браузер — uuid по пути, хост не важен.
 */

const MEDIA_PATH = /^\/api\/media\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

function parse(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

function mediaIdFromPath(pathname: string): string | null {
  return MEDIA_PATH.exec(pathname)?.[1] ?? null;
}

/** uuid файла, если адрес принадлежит этому приложению; иначе `null`. */
export function mediaIdFromAppMediaUrl(raw: string, appUrl: string): string | null {
  const url = parse(raw);
  if (url === null) return null;
  const app = parse(appUrl);
  if (app === null || url.origin !== app.origin) return null;
  return mediaIdFromPath(url.pathname);
}

/** uuid файла по пути `/api/media/<uuid>` на любом хосте; иначе `null`. */
export function mediaIdFromUrl(raw: string): string | null {
  const url = parse(raw);
  return url === null ? null : mediaIdFromPath(url.pathname);
}
