import { titleTokens } from "./MarketReferenceService.ts";

/**
 * Pure helpers for reading Dealabs search results — no network here, so
 * they can be tested against real captured pages.
 *
 * A Dealabs search page (`/search?q=…`) embeds every thread of the result
 * list as JSON in a `data-vue3` attribute (component
 * `ThreadMainListItemNormalizer`): price, the "prix constaté ailleurs"
 * the poster quoted, temperature, publication date, merchant. Only the
 * first page (~30 threads, mostly the last year) is available: `page=2`
 * redirects.
 */

export interface DealabsThread {
  id: string;
  title: string;
  price: number;
  /** "Prix constaté ailleurs" quoted by the poster, when given. */
  nextBestPrice?: number;
  temperature: number;
  isHot: boolean;
  isExpired: boolean;
  /** ISO date of publication. */
  publishedAt: string;
  merchant?: string;
  url: string;
}

function unescapeHtml(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

export function parseDealabsSearch(html: string): DealabsThread[] {
  const threads: DealabsThread[] = [];
  for (const match of html.matchAll(
    /data-vue3='([^']*)'|data-vue3="([^"]*)"/g,
  )) {
    try {
      const json = JSON.parse(unescapeHtml(match[1] ?? match[2] ?? ""));
      if (json?.name !== "ThreadMainListItemNormalizer") continue;
      const thread = json.props?.thread;
      const price = Number(thread?.price);
      if (!thread?.threadId || !thread.title || !(price > 0)) continue;
      threads.push({
        id: String(thread.threadId),
        title: String(thread.title),
        price,
        nextBestPrice:
          Number(thread.nextBestPrice) > price
            ? Number(thread.nextBestPrice)
            : undefined,
        temperature: Number(thread.temperature) || 0,
        isHot: !!thread.isHot,
        isExpired: !!thread.isExpired,
        publishedAt: new Date(Number(thread.publishedAt) * 1000).toISOString(),
        merchant: thread.merchant?.merchantName ?? undefined,
        url:
          thread.shareableLink ??
          `https://www.dealabs.com/bons-plans/${thread.threadId}`,
      });
    } catch {
      // Not a thread payload (other components use data-vue3 too).
    }
  }
  return threads;
}

/**
 * Words that turn one product into a different one: a "4K Plus" deal is no
 * reference for a plain "4K", a "Pro" phone none for the base model.
 */
export const VARIANT_WORDS = new Set([
  // Console versions of a game are other products than the PC/Steam one
  // (and than each other). "pc"/"steam" are deliberately absent: a Steam
  // title rarely says "PC", and a PC deal must still match it.
  "ps4",
  "ps5",
  "xbox",
  "switch",
  "nintendo",
  "plus",
  "max",
  "pro",
  "lite",
  "mini",
  "ultra",
  "select",
  "air",
  "se",
  "neo",
  "fe",
  "xl",
  "slim",
  "oled",
  "digital",
  "digitale",
  "standard",
  "deluxe",
  "gold",
  "collector",
  "reconditionne",
  "occasion",
]);

/**
 * The search query for a product: the first significant words of its
 * title. Merchant titles are long ("Amazon Fire TV Stick 4K Plus, avec
 * prise en charge du Wi-Fi 6 et…") and Dealabs search matches all words,
 * so a full title finds nothing.
 */
export function dealabsQuery(title: string): string {
  const head = title.split(/\s[|–—-]\s|,|\(|:/)[0] ?? title;
  return head.split(/\s+/).filter(Boolean).slice(0, 8).join(" ");
}

/** Deals for another country's store ("Frontalier Suisse", "[ES]"…). */
const FOREIGN =
  /frontalier|suisse|belgique|allemagne|espagne|italie|luxembourg|\[(?:de|es|it|be|ch|uk|nl)\]/i;
/** Merchants that are another country's store ("Amazon.es", "Amazon.de"…). */
const FOREIGN_MERCHANT = /\.(?:es|de|it|nl|be|ch|co\.uk|com\.be)$/i;

/**
 * Is this past thread about the same product? Every significant word of
 * our query must appear in it, and it must not add a variant word ours
 * lacks — plus a price sanity band (a 5 € "deal" on a 300 € product is an
 * accessory, a 3× price is a bundle).
 */
export function isSameProduct(
  ourTitle: string,
  ourPrice: number,
  thread: Pick<DealabsThread, "title" | "price"> & { merchant?: string },
): boolean {
  if (thread.merchant && FOREIGN_MERCHANT.test(thread.merchant.trim())) {
    return false;
  }
  const ours = titleTokens(dealabsQuery(ourTitle));
  const ourFull = titleTokens(ourTitle);
  const theirs = titleTokens(thread.title);
  if (ours.size < 2 || FOREIGN.test(thread.title)) return false;
  for (const token of ours) {
    if (!theirs.has(token)) return false;
  }
  // Variants must agree both ways: their "Plus" when we have none, or our
  // "Max" when they have none, are different products.
  for (const token of theirs) {
    if (VARIANT_WORDS.has(token) && !ourFull.has(token)) return false;
  }
  for (const token of ourFull) {
    if (VARIANT_WORDS.has(token) && !theirs.has(token)) return false;
  }
  return thread.price >= ourPrice * 0.4 && thread.price <= ourPrice * 2.5;
}

export interface DealabsHistorySummary {
  /** Matching past deals, oldest first, at most 20. */
  deals: DealabsThread[];
  lowest?: DealabsThread;
  bestTemperature?: number;
}

export function summarizeDealabsHistory(
  threads: DealabsThread[],
  ourTitle: string,
  ourPrice: number,
): DealabsHistorySummary {
  const deals = threads
    .filter((thread) => isSameProduct(ourTitle, ourPrice, thread))
    .sort((a, b) => a.publishedAt.localeCompare(b.publishedAt))
    .slice(-20);
  const lowest = deals.reduce<DealabsThread | undefined>(
    (best, deal) => (!best || deal.price < best.price ? deal : best),
    undefined,
  );
  return {
    deals,
    lowest,
    bestTemperature: deals.length
      ? Math.max(...deals.map((deal) => deal.temperature))
      : undefined,
  };
}
