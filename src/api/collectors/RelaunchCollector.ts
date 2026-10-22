import { dealabsQuery } from "../services/dealabsSearch.ts";
import type { HotWatchlistService } from "../services/HotWatchlistService.ts";
import {
  searchAmazon,
  titlesMatch,
} from "../services/MarketReferenceService.ts";
import type { AmazonCollector } from "./AmazonCollector.ts";
import {
  type CloudflareBrowserBinding,
  withBrowser,
  withPage,
} from "./browser.ts";
import type { DealSource, DiscoverContext, RawDeal } from "./DealSource.ts";

/** Watched products looked up on Amazon per run. */
const LOOKUPS_PER_RUN = 12;
/** "Back at its hot price": within 2 % of it, or below. */
const PRICE_TOLERANCE = 1.02;

/**
 * "Relances": products that already went hot on Dealabs (the watch list,
 * see `HotWatchlistService`) found back on Amazon by title; offered as a
 * deal only when the price is back to — or under — the price that made
 * them hot. The usual pipeline then adds the Dealabs history (the old
 * hot deal), the Keepa chart and the heat prediction, and the publish
 * step still refuses a live duplicate.
 */
export class RelaunchCollector implements DealSource {
  id = "relances";
  name = "Relances (déjà chauds sur Dealabs)";

  constructor(
    protected watchlist: HotWatchlistService,
    protected amazon: AmazonCollector,
    protected getCloudflareBinding?: () => CloudflareBrowserBinding | undefined,
  ) {}

  async discover(context?: DiscoverContext): Promise<RawDeal[]> {
    await this.watchlist.refreshIfStale((done, total) =>
      context?.progress?.("Lecture des deals chauds Dealabs", done, total),
    );
    const batch = await this.watchlist.nextBatch(LOOKUPS_PER_RUN);
    if (batch.length === 0) return [];

    return withBrowser(async (browser) => {
      const deals: RawDeal[] = [];
      for (const [index, hot] of batch.entries()) {
        context?.progress?.(
          "Recherche des produits sur Amazon",
          index + 1,
          batch.length,
        );
        try {
          const results = await withPage(browser, (page) =>
            searchAmazon(page, dealabsQuery(hot.title)),
          );
          const match = results.find((r) => titlesMatch(hot.title, r.title));
          if (!match || match.price > hot.price * PRICE_TOLERANCE) continue;
          // Back at its hot price: read the product page for the seller,
          // reviews, 30-day low… like any Amazon deal.
          const priced = await withPage(browser, (page) =>
            this.amazon.fetchPrice(page, match.url),
          );
          if (!priced || priced.price > hot.price * PRICE_TOLERANCE) continue;
          deals.push({
            externalId: match.url.split("/dp/")[1] ?? match.url,
            title: match.title,
            url: match.url,
            price: priced.price,
            listPrice: priced.listPrice,
            description: priced.description,
            currency: "EUR",
            availability: "in_stock",
            merchantId: "amazon",
            categoryHint: priced.breadcrumb
              ? `amazon-crumb:${priced.breadcrumb}`
              : undefined,
            details: priced.details,
          });
        } catch {
          // One lookup failing doesn't stop the others.
        }
      }
      return deals;
    }, this.getCloudflareBinding?.());
  }
}
