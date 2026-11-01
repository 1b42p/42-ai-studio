/**
 * Дата сессии в часовом поясе браузера. «сегодня» и «вчера» считаются
 * по календарным дням этого пояса, а не по прошедшим 24 часам.
 */

interface ZonedDay {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

function zonedDay(date: Date, timeZone: string): ZonedDay {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const read = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value);
  return { year: read("year"), month: read("month"), day: read("day") };
}

function daySerial(day: ZonedDay): number {
  return Math.floor(Date.UTC(day.year, day.month - 1, day.day) / 86_400_000);
}

export function formatSessionDate(date: Date, now: Date, timeZone: string): string {
  const current = zonedDay(date, timeZone);
  const today = zonedDay(now, timeZone);
  const delta = daySerial(current) - daySerial(today);

  if (delta === 0 || delta === -1) {
    const relative = new Intl.RelativeTimeFormat("ru", { numeric: "auto" }).format(delta, "day");
    const time = new Intl.DateTimeFormat("ru", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(date);
    return `${relative}, ${time}`;
  }

  return new Intl.DateTimeFormat("ru", {
    timeZone,
    day: "numeric",
    month: "long",
    ...(current.year === today.year ? {} : { year: "numeric" }),
  }).format(date);
}
