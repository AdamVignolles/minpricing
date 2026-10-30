import {
  categoriesForRun,
  emptyWatchStats,
  formatWatchStats,
  readBestSellerPage,
  type WatchedItem,
} from "../services/amazonWatch.ts";
import type { AmazonWatchService } from "../services/AmazonWatchService.ts";
import type { AmazonCollector } from "./AmazonCollector.ts";
import {
  type CloudflareBrowserBinding,
  withBrowser,
  withPage,
} from "./browser.ts";
import type { DealSource, DiscoverContext, RawDeal } from "./DealSource.ts";

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept-Language": "fr-FR,fr;q=0.9",
};

/**
 * Amazon.fr best-seller categories that list products (measured; "home",
 * "diy", "shoes"… render nothing to a plain request). Two pages each:
 * ~60 products per category, about half with an Amazon price.
 */
export const WATCH_CATEGORIES = [
  "electronics",
  "computers",
  "kitchen",
  "appliances",
  "videogames",
  "toys",
  "baby",
  "beauty",
  "hpc",
  "sports",
  "lawn-garden",
  "pet-supplies",
  "automotive",
  "musical-instruments",
];
/** Product pages opened per run for confirmed drops. */
const DROPS_PER_RUN = 12;

export interface AmazonWatchOptions {
  /** Categories read per run, taking turns (2 pages each). */
  categoriesPerRun: number;
  /** Items under this price are not watched: a 15 % drop saves too little. */
  minPrice: number;
  /** Known products (deals that are over) re-read on their page per run. */
  knownPerRun: number;
  /** Pause between two list pages, randomised in this range (ms). */
  spacingMs: [number, number];
  /** Overridable in tests. */
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
}

const DEFAULTS: AmazonWatchOptions = {
  categoriesPerRun: 4,
  minPrice: 20,
  knownPerRun: 8,
  spacingMs: [3_000, 6_000],
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => new Date(),
};

/**
 * « Amazon — baisses silencieuses »: price drops Amazon doesn't advertise.
 * Each run reads the best-seller lists of a few categories (plain fetch,
 * paced, taking turns so each category comes back every few hours, and
 * stopping at Amazon's first robot check), plus a few products we already
 * know on their own page (Amazon deals that are over). It records each
 * price (`AmazonWatchService`) and opens the product page only for clear,
 * steady drops against what we observed — those become deals whose
 * "normal price" is the one we measured. Every run notes where the items
 * went (`formatWatchStats`).
 */
export class AmazonWatchCollector implements DealSource {
  id = "amazon-watch";
  name = "Amazon (baisses de prix non affichées)";
  protected options: AmazonWatchOptions;

  constructor(
    protected watch: AmazonWatchService,
    protected amazon: AmazonCollector,
    protected getCloudflareBinding?: () => CloudflareBrowserBinding | undefined,
    options: Partial<AmazonWatchOptions> = {},
  ) {
    this.options = { ...DEFAULTS, ...options };
  }

  async discover(context?: DiscoverContext): Promise<RawDeal[]> {
    const { minPrice } = this.options;
    const categories = categoriesForRun(
      WATCH_CATEGORIES,
      this.options.categoriesPerRun,
      this.options.now(),
    );
    const stats = emptyWatchStats(categories);
    const items = new Map<string, WatchedItem>();
    const pages = categories.flatMap((category) => [
      `https://www.amazon.fr/gp/bestsellers/${category}`,
      `https://www.amazon.fr/gp/bestsellers/${category}?pg=2`,
    ]);
    for (const [index, url] of pages.entries()) {
      context?.progress?.("Meilleures ventes Amazon", index + 1, pages.length);
      if (index > 0) await this.options.sleep(this.spacing());
      try {
        const response = await fetch(url, {
          headers: HEADERS,
          signal: AbortSignal.timeout(20_000),
        });
        if (!response.ok) {
          stats.pagesEmpty++;
          continue;
        }
        const page = readBestSellerPage(await response.text());
        if (page.captcha) {
          // A robot check means stop for this run, not try harder.
          stats.pagesCaptcha++;
          stats.stoppedOnCaptcha = index < pages.length - 1;
          break;
        }
        if (page.cards === 0) stats.pagesEmpty++;
        else stats.pagesRead++;
        stats.cards += page.cards;
        stats.noPrice += page.noPrice;
        for (const item of page.items) {
          if (item.price < minPrice) {
            stats.tooCheap++;
            continue;
          }
          if (!items.has(item.asin)) items.set(item.asin, item);
        }
      } catch {
        // One list failing doesn't stop the others.
        stats.pagesEmpty++;
      }
    }

    const known = await this.watch.knownToRead(
      this.options.knownPerRun,
      minPrice,
      new Set(items.keys()),
    );
    if (known.length > 0) {
      context?.progress?.("Produits connus (fiches)");
      const read = await this.readKnown(known, context);
      stats.knownRead = read.length;
      stats.knownFailed = known.length - read.length;
      for (const item of read) items.set(item.asin, item);
    }

    context?.progress?.("Relevé des prix suivis");
    const watched = [...items.values()];
    stats.watched = watched.length;
    await this.watch.observe(watched);
    const drops = (await this.watch.findDrops(watched, stats)).slice(
      0,
      DROPS_PER_RUN,
    );
    const deals = drops.length ? await this.confirm(drops, context, stats) : [];
    stats.deals = deals.length;
    context?.note?.(formatWatchStats(stats));
    return deals;
  }

  protected spacing(): number {
    const [min, max] = this.options.spacingMs;
    return min + Math.random() * (max - min);
  }

  /** Known products on their own page: their price today, read by Amazon. */
  protected readKnown(
    known: Array<{ asin: string; title: string }>,
    context?: DiscoverContext,
  ): Promise<WatchedItem[]> {
    return withBrowser(async (browser) => {
      const items: WatchedItem[] = [];
      for (const [index, { asin, title }] of known.entries()) {
        context?.progress?.(
          "Produits connus (fiches)",
          index + 1,
          known.length,
        );
        const url = `https://www.amazon.fr/dp/${asin}`;
        try {
          const priced = await withPage(browser, (page) =>
            this.amazon.fetchPrice(page, url),
          );
          if (!priced) continue;
          items.push({
            asin,
            title: priced.title || title,
            price: priced.price,
            url,
            imageUrl: priced.imageUrl,
            rating: priced.details?.productRating,
            reviewCount: priced.details?.productReviewCount,
          });
        } catch {
          // One product page failing doesn't stop the others.
        }
      }
      return items;
    }, this.getCloudflareBinding?.());
  }

  /** The product page must confirm the drop before it becomes a deal. */
  protected confirm(
    drops: Awaited<ReturnType<AmazonWatchService["findDrops"]>>,
    context: DiscoverContext | undefined,
    stats: { unconfirmed: number },
  ): Promise<RawDeal[]> {
    return withBrowser(async (browser) => {
      const deals: RawDeal[] = [];
      for (const [index, { item, drop }] of drops.entries()) {
        context?.progress?.(
          "Fiches des produits en baisse",
          index + 1,
          drops.length,
        );
        try {
          const priced = await withPage(browser, (page) =>
            this.amazon.fetchPrice(page, item.url),
          );
          // The page must confirm the drop (a list can lag behind).
          if (!priced || priced.price > item.price * 1.02) {
            stats.unconfirmed++;
            continue;
          }
          const usual = drop.usualPrice.toFixed(2).replace(".", ",");
          deals.push({
            externalId: item.asin,
            title: item.title,
            url: item.url,
            imageUrl: item.imageUrl,
            price: priced.price,
            // Our own measurement of the usual price: a real former price.
            listPrice: drop.usualPrice,
            currency: "EUR",
            availability: "in_stock",
            merchantId: "amazon",
            categoryHint: priced.breadcrumb
              ? `amazon-crumb:${priced.breadcrumb}`
              : undefined,
            description: [
              priced.description,
              `- Baisse non affichée par Amazon : prix habituel ${usual} € (relevé par DealRadar sur ${drop.days} jours)`,
            ]
              .filter(Boolean)
              .join("\n"),
            details: {
              ...priced.details,
              listPriceKind: "regular",
              productRating: priced.details?.productRating ?? item.rating,
              productReviewCount:
                priced.details?.productReviewCount ?? item.reviewCount,
            },
          });
        } catch {
          // One product page failing doesn't stop the others.
          stats.unconfirmed++;
        }
      }
      return deals;
    }, this.getCloudflareBinding?.());
  }
}
