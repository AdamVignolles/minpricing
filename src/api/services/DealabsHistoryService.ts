import { $inject } from "alepha";
import { DateTimeProvider } from "alepha/datetime";
import { $logger } from "alepha/logger";
import { $repository } from "alepha/orm";

import { dealEntity } from "../entities/Deal.ts";
import {
  type DealabsThread,
  dealabsQuery,
  parseDealabsSearch,
  summarizeDealabsHistory,
} from "./dealabsSearch.ts";

/** Past deals don't change by the hour: re-check each product daily. */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Searches per collection run, spaced out. This reads Dealabs' public
 * search page (there is no API), so it stays deliberately gentle: a new
 * batch of deals gets its history over a few runs, not in one burst.
 */
const SEARCHES_PER_RUN = 25;
const SPACING_MS = 1_500;

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept-Language": "fr-FR,fr;q=0.9",
};

/** What `Deal.dealabsHistory` stores, one entry per past thread. */
export type StoredDealabsDeal = Pick<
  DealabsThread,
  | "price"
  | "publishedAt"
  | "temperature"
  | "isHot"
  | "merchant"
  | "url"
  | "title"
>;

/**
 * Finds past Dealabs deals for the same product and stores what they say:
 * the lowest price the community already got, how often and how hot it
 * was posted, and the list itself (for the detail page's chart).
 *
 * This is the price history that exists for *every* product, Amazon and
 * Cdiscount included: price-history sites (Idealo, leDénicheur,
 * camelcamelcamel) all block automated access, and Keepa is paid.
 * Dealabs' own search page answers a plain `fetch` (no browser), so this
 * also runs as-is on Cloudflare Workers.
 */
export class DealabsHistoryService {
  protected log = $logger();
  protected dateTime = $inject(DateTimeProvider);
  protected deals = $repository(dealEntity);

  /** @returns ids of the deals whose history was (re)checked. */
  async refreshStale(
    sourceId: string,
    onProgress?: (done: number, total: number) => void,
  ): Promise<string[]> {
    const candidates = await this.deals.findMany({
      where: {
        and: [{ sourceId: { eq: sourceId } }, { status: { eq: "active" } }],
      },
    });
    const now = Date.now();
    const stale = candidates
      .filter(
        (deal) =>
          !deal.dealabsCheckedAt ||
          now - new Date(deal.dealabsCheckedAt).getTime() > CACHE_TTL_MS,
      )
      .slice(0, SEARCHES_PER_RUN);

    for (const [index, deal] of stale.entries()) {
      onProgress?.(index + 1, stale.length);
      if (index > 0) {
        await new Promise((resolve) => setTimeout(resolve, SPACING_MS));
      }
      try {
        const threads = await this.search(dealabsQuery(deal.title));
        if (!threads) {
          // Blocked or down: don't mark as checked, retry next run.
          continue;
        }
        const summary = summarizeDealabsHistory(
          threads,
          deal.title,
          deal.currentPrice,
        );
        const stored: StoredDealabsDeal[] = summary.deals.map((thread) => ({
          title: thread.title,
          price: thread.price,
          publishedAt: thread.publishedAt,
          temperature: Math.round(thread.temperature),
          isHot: thread.isHot,
          merchant: thread.merchant,
          url: thread.url,
        }));
        await this.deals.updateById(deal.id, {
          dealabsLowestPrice: summary.lowest?.price,
          dealabsLowestAt: summary.lowest?.publishedAt,
          dealabsDealsCount: summary.deals.length,
          dealabsBestTemperature: summary.bestTemperature,
          dealabsHistory: stored.length ? JSON.stringify(stored) : undefined,
          dealabsCheckedAt: this.dateTime.nowISOString(),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.log.warn(`Dealabs history failed for "${deal.title}": ${message}`);
      }
    }

    return stale.map((deal) => deal.id);
  }

  /** @returns the threads, or `undefined` when Dealabs didn't answer. */
  protected async search(query: string): Promise<DealabsThread[] | undefined> {
    const response = await fetch(
      `https://www.dealabs.com/search?q=${encodeURIComponent(query)}`,
      { headers: HEADERS },
    );
    if (!response.ok) {
      return undefined;
    }
    return parseDealabsSearch(await response.text());
  }
}
