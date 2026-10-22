import { parseBestSellers, type WatchedItem } from "../services/amazonWatch.ts";
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
 * ~60 products with a price per category.
 */
const CATEGORIES = [
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
const SPACING_MS = 1_200;
/** Product pages opened per run for confirmed drops. */
const DROPS_PER_RUN = 12;

/**
 * « Amazon — baisses silencieuses »: price drops Amazon doesn't advertise.
 * Every run reads the best-seller lists (plain fetch, ~28 requests),
 * records each product's price (`AmazonWatchService`), and opens the
 * product page only for clear drops against what we observed — those
 * become deals whose "normal price" is the one we measured.
 */
export class AmazonWatchCollector implements DealSource {
  id = "amazon-watch";
  name = "Amazon (baisses de prix non affichées)";

  constructor(
    protected watch: AmazonWatchService,
    protected amazon: AmazonCollector,
    protected getCloudflareBinding?: () => CloudflareBrowserBinding | undefined,
  ) {}

  async discover(context?: DiscoverContext): Promise<RawDeal[]> {
    const items = new Map<string, WatchedItem>();
    const pages = CATEGORIES.flatMap((category) => [
      `https://www.amazon.fr/gp/bestsellers/${category}`,
      `https://www.amazon.fr/gp/bestsellers/${category}?pg=2`,
    ]);
    for (const [index, url] of pages.entries()) {
      context?.progress?.("Meilleures ventes Amazon", index + 1, pages.length);
      if (index > 0) await new Promise((r) => setTimeout(r, SPACING_MS));
      try {
        const response = await fetch(url, {
          headers: HEADERS,
          signal: AbortSignal.timeout(20_000),
        });
        if (!response.ok) continue;
        for (const item of parseBestSellers(await response.text())) {
          if (!items.has(item.asin)) items.set(item.asin, item);
        }
      } catch {
        // One list failing doesn't stop the others.
      }
    }

    context?.progress?.("Relevé des prix suivis");
    await this.watch.observe([...items.values()]);
    const drops = (await this.watch.findDrops([...items.values()])).slice(
      0,
      DROPS_PER_RUN,
    );
    if (drops.length === 0) return [];

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
          if (!priced || priced.price > item.price * 1.02) continue;
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
        }
      }
      return deals;
    }, this.getCloudflareBinding?.());
  }
}
