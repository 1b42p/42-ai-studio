/**
 * Название сессии из текста сообщения пользователя. Модель название не
 * придумывает: правила чисто текстовые, чтобы список и поиск были стабильны.
 */

const TITLE_MAX_CODE_POINTS = 60;
const URL_PATTERN = /https?:\/\/[^\s]+/gu;
const LEADING_MARKERS = /^[#>*`\-\s]+/u;

/** Событие потока, из которого можно взять текст сообщения. */
export interface TitleSourceEvent {
  readonly type: string;
  readonly data?: unknown;
}

/**
 * Заменяет адрес на имя хоста. `URL` приводит хост к нижнему регистру;
 * неразобранный фрагмент остаётся как был.
 */
function replaceUrls(text: string): string {
  return text.replace(URL_PATTERN, (match) => {
    try {
      return new URL(match).hostname;
    } catch {
      return match;
    }
  });
}

function codePoints(text: string): string[] {
  return Array.from(text);
}

/**
 * Не длиннее 60 кодпоинтов вместе с «…». Режется по последнему пробелу
 * в первых 59, если этот пробел не раньше 30-й позиции; иначе ровно на 59.
 * Считаем кодпоинты, а не единицы UTF-16, чтобы не разрезать суррогатную пару.
 */
function truncateTitle(text: string): string {
  const chars = codePoints(text);
  if (chars.length <= TITLE_MAX_CODE_POINTS) return text;

  const head = chars.slice(0, TITLE_MAX_CODE_POINTS - 1);
  let lastSpace = -1;
  for (let index = 0; index < head.length; index += 1) {
    if (head[index] === " ") lastSpace = index;
  }
  const cut = lastSpace >= 30 ? lastSpace : head.length;
  return chars.slice(0, cut).join("") + "…";
}

function capitalizeFirst(text: string): string {
  const chars = codePoints(text);
  if (chars.length === 0) return text;
  chars[0] = chars[0].toLocaleUpperCase("ru");
  return chars.join("");
}

/** Название из сырого текста или `null`, если после очистки текста не осталось. */
export function sessionTitleFromText(text: string): string | null {
  const normalized = replaceUrls(text)
    .replace(/\s+/gu, " ")
    .replace(LEADING_MARKERS, "")
    .trim();
  if (normalized === "") return null;
  const title = capitalizeFirst(truncateTitle(normalized));
  return title === "" ? null : title;
}

/**
 * Ключ поиска. Регистр и «ё» снимаются в приложении: `lower()` в Postgres
 * зависит от LC_CTYPE и в локали C кириллицу не меняет.
 */
export function titleSearchKey(title: string): string {
  return title.toLocaleLowerCase("ru").replaceAll("ё", "е").replaceAll("Ё", "е");
}

function textFromMessage(data: unknown): string | null {
  if (data === null || typeof data !== "object") return null;
  const record = data as { parts?: unknown; message?: unknown };

  if (Array.isArray(record.parts)) {
    const texts: string[] = [];
    for (const part of record.parts) {
      if (part === null || typeof part !== "object") continue;
      const item = part as { type?: unknown; text?: unknown };
      if (item.type === "text" && typeof item.text === "string") texts.push(item.text);
    }
    const joined = texts.join("");
    // Сводка вложения лежит в data.message (`[file: …]`). Текстовых частей нет —
    // это не название, его даст следующее сообщение.
    if (joined.trim() === "") return null;
    return joined;
  }

  if (typeof record.message === "string" && record.message.trim() !== "") {
    return record.message;
  }
  return null;
}

/**
 * Первое сообщение пользователя, из которого получается название.
 * Вложение без текста и пустая разметка название не ставят.
 */
export function titleFromEvents(events: readonly TitleSourceEvent[]): string | null {
  for (const event of events) {
    if (event.type !== "message.received") continue;
    const text = textFromMessage(event.data);
    if (text === null) continue;
    const title = sessionTitleFromText(text);
    if (title !== null) return title;
  }
  return null;
}
