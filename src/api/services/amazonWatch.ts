/**
 * Silent price drops on Amazon: products whose price falls without Amazon
 * showing any promotion (no struck price, no "Offre" badge), so they never
 * reach the /deals pages. DealRadar becomes the tracker: it watches
 * Amazon's best sellers per category, records their price every run
 * (`PriceHistory`, key `watch:<ASIN>`), and flags a clear drop against
 * what it observed. Pure parts here; fetching in `AmazonWatchCollector`.
 */

export interface WatchedItem {
  asin: string;
  title: string;
  price: number;
  url: string;
  imageUrl?: string;
  rating?: number;
  reviewCount?: number;
}

/** "1 049,99" → 1049.99 */
function euro(text: string): number {
  return Number(text.replace(/[\s  ]/g, "").replace(",", "."));
}

function decode(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * An Amazon best-sellers page (`/gp/bestsellers/<category>`): the ~30
 * server-rendered cards (`id="gridItemRoot"`), each with ASIN, title,
 * price, rating and review count.
 */
export function parseBestSellers(html: string): WatchedItem[] {
  return readBestSellerPage(html).items;
}

export interface BestSellerPage {
  items: WatchedItem[];
  /** Product cards on the page. */
  cards: number;
  /**
   * Cards with no price of their own: « N offres à partir de … », sold
   * only by marketplace sellers (no Amazon buy box). Not watched.
   */
  noPrice: number;
  /** Amazon's robot check instead of the list. */
  captcha: boolean;
}

/** One best-seller page: its items, and what it was made of. */
export function readBestSellerPage(html: string): BestSellerPage {
  const cards = html.split('id="gridItemRoot"').slice(1);
  let noPrice = 0;
  const items = cards.flatMap((card): WatchedItem[] => {
    const asin = card.match(/data-asin="([A-Z0-9]{10})"/)?.[1];
    const price = card.match(/(\d[\d\s  ]*,\d{2})\s?€/)?.[1];
    const title =
      card.match(/_cDEzb_p13n-sc-css-line-clamp-\d+_[^"]*">([^<]+)/)?.[1] ??
      card.match(/<img alt="([^"]+)"/)?.[1];
    if (asin && title && !price) noPrice++;
    if (!asin || !price || !title) return [];
    // « 4,8 sur 5\u00a0étoiles, 55\u00a0840\u00a0évaluations » (aria-label),
    // or the older « 4,6 sur 5 étoiles » + count span.
    const rating = card.match(
      /(\d,\d)[\s\u00a0]sur[\s\u00a0]5[\s\u00a0]étoiles/,
    )?.[1];
    const reviews =
      card.match(
        /étoiles,[\s\u00a0]([\d\s\u00a0\u202f]+?)[\s\u00a0]évaluations/,
      )?.[1] ?? card.match(/a-size-small">([\d\s\u00a0\u202f]+)<\/span>/)?.[1];
    return [
      {
        asin,
        title: decode(title),
        price: euro(price),
        url: `https://www.amazon.fr/dp/${asin}`,
        imageUrl: card.match(/<img[^>]*src="(https:\/\/[^"]+)"/)?.[1],
        rating: rating ? Number(rating.replace(",", ".")) : undefined,
        reviewCount: reviews ? Number(reviews.replace(/\D/g, "")) : undefined,
      },
    ];
  });
  return {
    items,
    cards: cards.length,
    noPrice,
    captcha: cards.length === 0 && isCaptchaPage(html),
  };
}

/** Amazon's « Saisissez les caractères » robot check. */
export function isCaptchaPage(html: string): boolean {
  return /validateCaptcha|captcha/i.test(html);
}

/**
 * The categories one run reads: `perRun` of them, taking turns hour by
 * hour so every category comes back every few hours. A burst of 28
 * pages trips Amazon's robot check; a few pages an hour don't.
 */
export function categoriesForRun<T>(
  categories: T[],
  perRun: number,
  now: Date,
): T[] {
  if (perRun >= categories.length) return [...categories];
  const turns = Math.ceil(categories.length / perRun);
  const turn = Math.floor(now.getTime() / 3_600_000) % turns;
  return categories.slice(turn * perRun, turn * perRun + perRun);
}

export interface Observation {
  price: number;
  /** ISO date-time. */
  observedAt: string;
}

export interface SilentDrop {
  /** Price in force most days of the last 30 (today excluded). */
  usualPrice: number;
  /** Lowest daily price of the last 30 days (today excluded). */
  monthLow: number;
  /** Days covered by our observations. */
  days: number;
}

/** Watched for less than this, we don't know the product's usual price. */
const MIN_WATCH_DAYS = 3;
const MIN_DROP = 0.15;
const MIN_SAVING_EUROS = 5;
const MIN_PLAUSIBLE_RATIO = 1 / 3;
const DAY_MS = 86_400_000;

/**
 * Is `price` a clear drop against what we observed? Needs three days of
 * watching; the usual price is the median of the daily prices of the
 * last 30 days (each day takes the price in force that day), today left
 * out. A drop is ≥ 15 % and ≥ 5 € under it, and at or under the month's
 * lowest — otherwise it's just the product's normal back-and-forth.
 */
export function silentDrop(
  observations: Observation[],
  price: number,
  now = new Date(),
): SilentDrop | undefined {
  const verdict = assessSilentDrop(observations, price, now);
  return "drop" in verdict ? verdict.drop : undefined;
}

/** Why a watched price is not a silent drop (counted in the run stats). */
export type DropRejection =
  | "too-young"
  | "implausible"
  | "under-15pct"
  | "under-5eur"
  | "above-month-low"
  | "unstable";

/**
 * Before a drop, the price must have been steady: at least this share of
 * the last {@link STABLE_DAYS} days' observations within ±5 % of the usual
 * price. A buy box changing hands all day (53 → 42 → 54 → 42 €) is noise.
 */
const STABLE_SHARE = 0.7;
const STABLE_DAYS = 3;
const STABLE_SPREAD = 0.05;

/** {@link silentDrop} with the reason when it isn't one. */
export function assessSilentDrop(
  observations: Observation[],
  price: number,
  now = new Date(),
): { drop: SilentDrop } | { reason: DropRejection } {
  const sorted = [...observations].sort((a, b) =>
    a.observedAt.localeCompare(b.observedAt),
  );
  if (sorted.length === 0) return { reason: "too-young" };
  const first = new Date(sorted[0].observedAt).getTime();
  if (now.getTime() - first < MIN_WATCH_DAYS * DAY_MS) {
    return { reason: "too-young" };
  }

  const today = Math.floor(now.getTime() / DAY_MS) * DAY_MS;
  const start = Math.max(first, today - 30 * DAY_MS);
  const daily: number[] = [];
  for (
    let day = Math.floor(start / DAY_MS) * DAY_MS;
    day < today;
    day += DAY_MS
  ) {
    // The price in force at the end of that day.
    const inForce = sorted
      .filter((o) => new Date(o.observedAt).getTime() < day + DAY_MS)
      .pop();
    if (inForce) daily.push(inForce.price);
  }
  if (daily.length < MIN_WATCH_DAYS) return { reason: "too-young" };
  const ordered = [...daily].sort((a, b) => a - b);
  const usualPrice = ordered[Math.floor(ordered.length / 2)];
  const monthLow = ordered[0];
  // More than two-thirds off what we saw is a listing glitch (a seller's
  // 9 999 € placeholder replaced by a real offer), not a deal.
  if (price < usualPrice * MIN_PLAUSIBLE_RATIO) {
    return { reason: "implausible" };
  }
  if (price > usualPrice * (1 - MIN_DROP)) return { reason: "under-15pct" };
  if (usualPrice - price < MIN_SAVING_EUROS) return { reason: "under-5eur" };
  if (price > monthLow * 1.01) return { reason: "above-month-low" };

  // Steady before the drop? Every observation of the last days, plus the
  // price in force when that window opened.
  const windowStart = today - STABLE_DAYS * DAY_MS;
  const before = sorted.filter(
    (o) => new Date(o.observedAt).getTime() < windowStart,
  );
  const recent = [
    ...before.slice(-1),
    ...sorted.filter((o) => {
      const t = new Date(o.observedAt).getTime();
      return t >= windowStart && t < today;
    }),
  ];
  const steady = recent.filter(
    (o) => Math.abs(o.price - usualPrice) <= usualPrice * STABLE_SPREAD,
  ).length;
  if (recent.length > 0 && steady / recent.length < STABLE_SHARE) {
    return { reason: "unstable" };
  }
  return { drop: { usualPrice, monthLow, days: daily.length } };
}

/** What one amazon-watch run saw, for its log line (`formatWatchStats`). */
export interface WatchRunStats {
  categories: string[];
  pagesRead: number;
  pagesCaptcha: number;
  pagesEmpty: number;
  /** Stopped reading lists after a robot check. */
  stoppedOnCaptcha: boolean;
  cards: number;
  noPrice: number;
  /** Items under the minimum price to watch. */
  tooCheap: number;
  /** Known products (expired deals, hot list) read on their own page. */
  knownRead: number;
  knownFailed: number;
  watched: number;
  rejected: Partial<Record<DropRejection, number>>;
  drops: number;
  /** Drops Amazon already shows as a promotion (an active amazon deal). */
  promoted: number;
  /** Drops the product page didn't confirm. */
  unconfirmed: number;
  deals: number;
}

export const emptyWatchStats = (categories: string[] = []): WatchRunStats => ({
  categories,
  pagesRead: 0,
  pagesCaptcha: 0,
  pagesEmpty: 0,
  stoppedOnCaptcha: false,
  cards: 0,
  noPrice: 0,
  tooCheap: 0,
  knownRead: 0,
  knownFailed: 0,
  watched: 0,
  rejected: {},
  drops: 0,
  promoted: 0,
  unconfirmed: 0,
  deals: 0,
});

const REJECTION_LABEL: Record<DropRejection, string> = {
  "too-young": "moins de 3 jours de relevés",
  implausible: "baisse invraisemblable",
  "under-15pct": "moins de 15 %",
  "under-5eur": "moins de 5 €",
  "above-month-low": "au-dessus du plus bas du mois",
  unstable: "prix instable",
};

/** One French line for the run log: where the items went. */
export function formatWatchStats(stats: WatchRunStats): string {
  const rejected = Object.entries(stats.rejected)
    .filter(([, n]) => n)
    .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
    .map(([reason, n]) => `${REJECTION_LABEL[reason as DropRejection]} ${n}`)
    .join(", ");
  return [
    `Listes ${stats.categories.join(", ") || "aucune"} : ${stats.pagesRead} page(s) lue(s), ${stats.pagesCaptcha} contrôle(s) anti-robot, ${stats.pagesEmpty} vide(s)${stats.stoppedOnCaptcha ? " (lecture arrêtée au contrôle)" : ""}`,
    `${stats.cards} fiches, ${stats.noPrice} sans prix Amazon, ${stats.tooCheap} trop bon marché`,
    `produits connus relus ${stats.knownRead}${stats.knownFailed ? ` (${stats.knownFailed} échec(s))` : ""}`,
    `${stats.watched} prix suivis${rejected ? ` · écartés : ${rejected}` : ""}`,
    `${stats.drops} baisse(s), ${stats.promoted} déjà en promo, ${stats.unconfirmed} non confirmée(s), ${stats.deals} deal(s)`,
  ].join(" · ");
}
