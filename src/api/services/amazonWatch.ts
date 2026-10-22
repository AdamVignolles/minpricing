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
  return html
    .split('id="gridItemRoot"')
    .slice(1)
    .flatMap((card) => {
      const asin = card.match(/data-asin="([A-Z0-9]{10})"/)?.[1];
      const price = card.match(/(\d[\d\s  ]*,\d{2})\s?€/)?.[1];
      const title =
        card.match(/_cDEzb_p13n-sc-css-line-clamp-\d+_[^"]*">([^<]+)/)?.[1] ??
        card.match(/<img alt="([^"]+)"/)?.[1];
      if (!asin || !price || !title) return [];
      const rating = card.match(/(\d,\d) sur 5 étoiles/)?.[1];
      const reviews = card.match(/a-size-small">([\d\s  ]+)<\/span>/)?.[1];
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
  const sorted = [...observations].sort((a, b) =>
    a.observedAt.localeCompare(b.observedAt),
  );
  if (sorted.length === 0) return undefined;
  const first = new Date(sorted[0].observedAt).getTime();
  if (now.getTime() - first < MIN_WATCH_DAYS * DAY_MS) return undefined;

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
  if (daily.length < MIN_WATCH_DAYS) return undefined;
  const ordered = [...daily].sort((a, b) => a - b);
  const usualPrice = ordered[Math.floor(ordered.length / 2)];
  const monthLow = ordered[0];
  // More than two-thirds off what we saw is a listing glitch (a seller's
  // 9 999 € placeholder replaced by a real offer), not a deal.
  if (price < usualPrice * MIN_PLAUSIBLE_RATIO) return undefined;
  const isDrop =
    price <= usualPrice * (1 - MIN_DROP) &&
    usualPrice - price >= MIN_SAVING_EUROS &&
    price <= monthLow * 1.01;
  return isDrop ? { usualPrice, monthLow, days: daily.length } : undefined;
}
