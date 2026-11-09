import { formatMegabytes, formatMinutes } from "./policy";

export type DownloadCode =
  | "download_not_configured"
  | "download_no_session"
  | "download_bad_url"
  | "download_blocked_address"
  | "download_unsupported_site"
  | "download_playlist"
  | "download_live"
  | "download_unavailable"
  | "download_login_required"
  | "download_geo_blocked"
  | "download_drm"
  | "download_too_large"
  | "download_timeout"
  | "download_rate_limited"
  | "download_network"
  | "download_no_space"
  | "download_bad_media"
  | "download_failed"
  | "download_busy";

const FIXED: Partial<Record<DownloadCode, string>> = {
  download_not_configured: "Скачивание видео не настроено на сервере. Сообщите оператору сервиса.",
  download_no_session: "Не удалось определить сессию для сохранения видео.",
  download_bad_url: "Нужна обычная ссылка http или https на страницу с видео.",
  download_unsupported_site: "Этот сайт не поддерживается. Прямые ссылки на файлы и страницы со встроенным плеером не скачиваются.",
  download_playlist: "Ссылка ведёт на список видео. Дайте ссылку на одно видео.",
  download_live: "Это прямая трансляция или ещё не вышедшее видео. Скачать можно только готовую запись.",
  download_unavailable: "Видео недоступно: оно удалено, скрыто или закрыто автором.",
  download_geo_blocked: "Видео недоступно в регионе сервера.",
  download_drm: "Видео защищено от копирования, скачать его нельзя.",
  download_rate_limited: "Сайт ограничил частоту запросов. Повторите через несколько минут.",
  download_network: "Не удалось связаться с сайтом. Повторите позже.",
  download_bad_media: "Скачанный файл не удалось прочитать как видео.",
  download_busy: "Сервис загрузки занят, повторите через несколько минут.",
};

export function downloadMessage(
  code: DownloadCode,
  details: {
    readonly host?: string;
    readonly youtube?: boolean;
    readonly hasCookies?: boolean;
    readonly actualBytes?: number;
    readonly limitBytes?: number;
    readonly timeoutMs?: number;
    readonly neededBytes?: number;
    readonly freeBytes?: number;
    readonly reason?: string;
  } = {},
): string {
  if (code === "download_blocked_address") {
    return `Адрес «${details.host ?? ""}» относится к внутренней сети, скачивать с него нельзя.`;
  }
  if (code === "download_login_required") {
    const base = "Видео требует входа в аккаунт.";
    if (details.youtube !== true) return base;
    return details.hasCookies === true
      ? `${base} Сохранённые данные входа не подошли, сообщите оператору.`
      : `${base} У сервиса нет данных входа, сообщите оператору.`;
  }
  if (code === "download_too_large") {
    return `Видео слишком большое (около ${formatMegabytes(details.actualBytes ?? 0)} МБ при пределе ${formatMegabytes(details.limitBytes ?? 0)} МБ). Выберите меньшее качество (maxHeight) или другое видео.`;
  }
  if (code === "download_timeout") {
    return `Скачивание заняло больше ${formatMinutes(details.timeoutMs ?? 0)} мин и прервано. Выберите меньшее качество или более короткое видео.`;
  }
  if (code === "download_no_space") {
    return `В песочнице не хватает места для видео (нужно около ${formatMegabytes(details.neededBytes ?? 0)} МБ, свободно ${formatMegabytes(details.freeBytes ?? 0)} МБ). Удалите ненужные файлы.`;
  }
  if (code === "download_failed") {
    const reason = details.reason && details.reason.length > 0 ? details.reason : "неизвестная ошибка";
    return `Не удалось скачать видео: ${reason}.`;
  }
  return FIXED[code] ?? "Не удалось скачать видео: неизвестная ошибка.";
}

export class DownloadToolError extends Error {
  readonly code: DownloadCode;

  constructor(code: DownloadCode, details?: Parameters<typeof downloadMessage>[1]) {
    super(`${code}: ${downloadMessage(code, details)}`);
    this.name = "DownloadToolError";
    this.code = code;
  }
}

export function downloadError(code: DownloadCode, details?: Parameters<typeof downloadMessage>[1]): DownloadToolError {
  return new DownloadToolError(code, details);
}
