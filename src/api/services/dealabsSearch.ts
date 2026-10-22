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
  /** Username of whoever posted it. */
  poster?: string;
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
        poster: thread.user?.username ?? undefined,
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
/** Console platforms among the variant words (see `isSameProduct`). */
const PLATFORM_WORDS = new Set(["ps4", "ps5", "xbox", "switch", "nintendo"]);

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
  // Sneaker variants: a "Gazelle Indoor" isn't a "Gazelle".
  "indoor",
  "bold",
  "platform",
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
/** Threads about several products at once. */
const MULTI_PRODUCT =
  /humble|bundle|\bchoice\b|game pass|ps plus|abonnement|s[ée]lection de|jusqu'à -\d+ ?% sur/i;
/** Letters and digits mixed: a model code ("tr120", "x1504va", "55t69c"). */
const MODEL_CODE = /^(?=.*\d)(?=.*[a-z])[a-z0-9]{3,}$/;
/** …but not a quantity ("128go", "1000w", "4k", "5g", "ps5"). */
const UNIT =
  /^(\d+(go|to|gb|tb|mo|mah|w|cm|mm|m|pa|kpa|hz|l|ml|g|kg|v|k|p|x)|ps\d|[45]g)$/;
/** Baby / child sizes. */
const KIDS =
  /b[ée]b[ée]s?(?![a-z])|\benfants?\b|\bjunior\b|maternelle|primaire|coll[eè]ge|\bkids?\b|\(j\)|\btoddler/i;

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
  // A bundle or a roundup ("Humble Choice - RE Village, Core Keeper, …")
  // says nothing about one of the products it lists.
  if (
    MULTI_PRODUCT.test(thread.title) ||
    (thread.title.match(/,/g)?.length ?? 0) >= 3
  ) {
    return false;
  }
  const head = dealabsQuery(ourTitle);
  const ours = titleTokens(head);
  const ourFull = titleTokens(ourTitle);
  const theirs = titleTokens(thread.title);
  if (ours.size < 2 || FOREIGN.test(thread.title)) return false;
  for (const token of ours) {
    if (!theirs.has(token)) return false;
  }
  // A short searched name ("Asus TUF Gaming") fits a whole range: the
  // model code right after it ("TR120") must be there too.
  if (ours.size < 4) {
    const code = [...titleTokens(ourTitle.slice(head.length))]
      .slice(0, 3)
      .find((token) => MODEL_CODE.test(token) && !UNIT.test(token));
    if (code && !theirs.has(code)) return false;
  }
  // Baby/child sizes and adult sizes are different products.
  if (KIDS.test(ourTitle) !== KIDS.test(thread.title)) return false;
  // Platforms: a thread listing several ("sur PS5 et Xbox Series X", "sur
  // PS5, PC ou Switch 2") is our deal if one of them is ours.
  const ourPlatforms = [...ourFull].filter((t) => PLATFORM_WORDS.has(t));
  const theirPlatforms = [...theirs].filter((t) => PLATFORM_WORDS.has(t));
  if (ourPlatforms.length || theirPlatforms.length) {
    if (!ourPlatforms.some((platform) => theirs.has(platform))) return false;
  }
  // Other variants must agree both ways: their "Plus" when we have none,
  // or our "Max" when they have none, are different products.
  for (const token of theirs) {
    if (
      VARIANT_WORDS.has(token) &&
      !PLATFORM_WORDS.has(token) &&
      !ourFull.has(token)
    ) {
      return false;
    }
  }
  for (const token of ourFull) {
    if (
      VARIANT_WORDS.has(token) &&
      !PLATFORM_WORDS.has(token) &&
      !theirs.has(token)
    ) {
      return false;
    }
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

/** A live deal this recent for the same product makes ours a duplicate. */
export const DUPLICATE_WINDOW_DAYS = 30;

/**
 * Is this product already on Dealabs right now — same product (see
 * `isSameProduct`), not expired, posted within the last 30 days, at our
 * price or cheaper? A repost of that gets voted cold or deleted as a
 * duplicate. A pricier earlier deal doesn't count: ours is then the news.
 */
export function findLiveDuplicate(
  threads: DealabsThread[],
  ourTitle: string,
  ourPrice: number,
  now = new Date(),
): DealabsThread | undefined {
  return threads
    .filter(
      (thread) =>
        !thread.isExpired &&
        now.getTime() - new Date(thread.publishedAt).getTime() <
          DUPLICATE_WINDOW_DAYS * 86_400_000 &&
        thread.price <= ourPrice * 1.02 &&
        isSameProduct(ourTitle, ourPrice, thread),
    )
    .sort((a, b) => a.price - b.price)[0];
}

/** What a deal card says when the product is already on Dealabs. */
export interface OnDealabs {
  url: string;
  price: number;
  temperature: number;
  /** Our own post (published draft), not someone else's. */
  mine: boolean;
}

/**
 * The live Dealabs deal for this product, from its stored history (already
 * matched by `isSameProduct`): not expired, posted within 30 days — at
 * any price: the product is "already on Dealabs" either way (the card
 * shows that deal's price, so a cheaper offer of ours is still visible).
 * Ours first, then the cheapest. History stored before expiry was
 * recorded has no `isExpired`: such an entry counts only if posted in the
 * last 7 days.
 */
export function liveOnDealabs(
  history: Array<{
    url: string;
    price: number;
    temperature: number;
    publishedAt: string;
    isExpired?: boolean;
    mine?: boolean;
  }>,
  _currentPrice: number,
  now = new Date(),
): OnDealabs | undefined {
  const age = (at: string) => now.getTime() - new Date(at).getTime();
  return history
    .filter(
      (past) =>
        age(past.publishedAt) < DUPLICATE_WINDOW_DAYS * 86_400_000 &&
        (past.isExpired === false ||
          (past.isExpired === undefined &&
            age(past.publishedAt) < 7 * 86_400_000)),
    )
    .sort((a, b) => Number(!!b.mine) - Number(!!a.mine) || a.price - b.price)
    .map(({ url, price, temperature, mine }) => ({
      url,
      price,
      temperature: Math.round(temperature),
      mine: !!mine,
    }))[0];
}
