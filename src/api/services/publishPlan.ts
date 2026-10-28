/**
 * Pure helpers of the in-app publishing plan (`PublishScheduleService`):
 * Paris days and times, whatever the server's timezone, and the same
 * random draw `dealradar.mjs publish-queue` used.
 */
const PARIS = "Europe/Paris";

const parts = (date: Date) =>
  Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: PARIS,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "short",
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  ) as Record<string, string>;

/** YYYY-MM-DD of `date` in Paris. */
export function parisDay(date: Date): string {
  const p = parts(date);
  return `${p.year}-${p.month}-${p.day}`;
}

/** HH:MM of `date` in Paris. */
export function parisTime(date: Date): string {
  const p = parts(date);
  return `${p.hour}:${p.minute}`;
}

/** 1 = Monday … 7 = Sunday, in Paris (the rules' `publishDays`). */
export function parisWeekday(date: Date): number {
  return (
    ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(
      parts(date).weekday,
    ) + 1
  );
}

/** Paris UTC offset at `date`, in ms (+1 h in winter, +2 h in summer). */
function parisOffset(date: Date): number {
  const p = parts(date);
  const asUtc = Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    Number(p.hour),
    Number(p.minute),
    Number(p.second),
  );
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** The instant of `HH:MM` on Paris day `day` (YYYY-MM-DD). */
export function atParis(day: string, hhmm: string): Date {
  const [y, m, d] = day.split("-").map(Number);
  const [h, mi] = hhmm.split(":").map(Number);
  const guess = Date.UTC(y, m - 1, d, h, mi);
  let at = guess - parisOffset(new Date(guess));
  // Once more, in case the guess and the answer straddle a DST change.
  at = guess - parisOffset(new Date(at));
  return new Date(at);
}

export const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** `count` random times in [from, to], at least `gapMinutes` apart, sorted. */
export function randomTimes(
  count: number,
  from: Date,
  to: Date,
  gapMinutes: number,
  random: () => number = Math.random,
): Date[] {
  const gap = gapMinutes * 60_000;
  const span = to.getTime() - from.getTime();
  if (span < 0 || count <= 0) return [];
  const n = Math.min(count, Math.floor(span / gap) + 1);
  const free = span - (n - 1) * gap;
  return Array.from({ length: n }, () => random() * free)
    .sort((a, b) => a - b)
    .map((offset, i) => new Date(from.getTime() + offset + i * gap));
}
