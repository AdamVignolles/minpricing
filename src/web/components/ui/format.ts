/**
 * Formatting helpers shared by every view.
 *
 * All of them are pure and deterministic so the SSR render and the
 * hydration render agree — the one exception is {@link relativeTime}, which
 * reads the clock and is therefore only used inside client-rendered islands
 * or where a one-frame correction is harmless.
 */

const EUR = new Intl.NumberFormat("fr-FR", {
  style: "currency",
  currency: "EUR",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const EUR_COMPACT = new Intl.NumberFormat("fr-FR", {
  style: "currency",
  currency: "EUR",
  maximumFractionDigits: 0,
});

const DATE = new Intl.DateTimeFormat("fr-FR", {
  day: "2-digit",
  month: "short",
  year: "numeric",
});

const DATE_TIME = new Intl.DateTimeFormat("fr-FR", {
  day: "2-digit",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});

const DAY_SHORT = new Intl.DateTimeFormat("fr-FR", {
  day: "2-digit",
  month: "2-digit",
});

/** `79,99 €`. Falls back to the raw currency code for non-EUR sources. */
export const price = (value: number, currency = "EUR"): string =>
  currency === "EUR"
    ? EUR.format(value)
    : `${value.toFixed(2)} ${currency}`.replace(".", ",");

/** `1 240 €` — for aggregates where cents are noise. */
export const priceCompact = (value: number): string =>
  EUR_COMPACT.format(value);

/** `-42 %`, with a real minus sign and a non-breaking space. */
export const discount = (value: number): string =>
  `\u2212${Math.round(value)}\u00a0%`;

export const percent = (value: number, digits = 0): string =>
  `${value.toFixed(digits).replace(".", ",")}\u00a0%`;

export const date = (value: string | Date): string =>
  DATE.format(new Date(value));

export const dateTime = (value: string | Date): string =>
  DATE_TIME.format(new Date(value));

export const dayShort = (value: string | Date): string =>
  DAY_SHORT.format(new Date(value));

/**
 * `il y a 3 h`, `il y a 2 j`. Returns `null` for the future or for
 * unparseable input so callers can skip the label entirely rather than
 * print something nonsensical.
 *
 * `now` is injectable so React components can pass a render-stable clock
 * (see `useNow`) instead of reading the impure `Date.now()` mid-render.
 */
export const relativeTime = (
  value: string | Date | undefined,
  now: number = Date.now(),
): string | null => {
  if (!value) return null;
  const then = new Date(value).getTime();
  if (Number.isNaN(then)) return null;
  const diff = now - then;
  if (diff < 0) return null;
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "à l'instant";
  if (minutes < 60) return `il y a ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `il y a ${hours} h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `il y a ${days} j`;
  const months = Math.floor(days / 30);
  if (months < 12) return `il y a ${months} mois`;
  return `il y a ${Math.floor(months / 12)} an${months >= 24 ? "s" : ""}`;
};

/** `2 min 14 s` / `820 ms` — for job durations. */
export const duration = (ms: number | null | undefined): string => {
  if (ms === null || ms === undefined) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} min ${seconds % 60} s`;
};

/** `12`, `1,2 k` — keeps big counters from breaking a stat tile's layout. */
export const compactNumber = (value: number): string =>
  value < 1000
    ? String(value)
    : `${(value / 1000).toFixed(1).replace(".", ",").replace(",0", "")} k`;

/**
 * Savings in euros between the reference price and what you pay.
 * `null` when there is no reference price — a deal without a known list
 * price must not claim a saving of 0 €.
 */
export const savings = (
  currentPrice: number,
  listPrice: number | undefined,
): number | null =>
  listPrice !== undefined && listPrice > currentPrice
    ? listPrice - currentPrice
    : null;

/** Human label for a merchant/category id we have no row for. */
export const titleize = (value: string): string =>
  value
    .split(/[-_]/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
