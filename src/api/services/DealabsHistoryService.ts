import { $env, $inject, z } from "alepha";
import { DateTimeProvider } from "alepha/datetime";
import { $logger } from "alepha/logger";
import { $repository } from "alepha/orm";

import { dealEntity } from "../entities/Deal.ts";
import {
  type DealabsThread,
  dealabsQuery,
  findLiveDuplicate,
  parseDealabsSearch,
  summarizeDealabsHistory,
} from "./dealabsSearch.ts";
import { MIN_VISIBLE_SCORE } from "./ScoringService.ts";

/** Past deals don't change by the hour: re-check each product daily. */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Searches per collection run, spaced out. This reads Dealabs' public
 * search page (there is no API), so it stays deliberately gentle: a new
 * batch of deals gets its history over a few runs, not in one burst.
 * Per source: with ~16 sources the app-wide pacing makes this the run's
 * longest step, hence 15 and the most promising deals first.
 */
const SEARCHES_PER_RUN = 15;
/** A deal this far under the visibility bar won't get there on history. */
const MIN_SCORE_TO_CHECK = 30;
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
> & {
  /** Recorded since Oct. 2026: missing on older history. */
  isExpired?: boolean;
  /** Posted by us (`DEALABS_USERNAME`): shown, never counted. */
  mine?: boolean;
};

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
  protected env = $env(
    z.object({
      /**
       * Your Dealabs username: your own threads are left out of a
       * product's history, or every deal you post would come back as "its
       * own previous deal" (same price, its own temperature).
       */
      DEALABS_USERNAME: z.string().default(""),
    }),
  );

  /** @returns ids of the deals whose history was (re)checked. */
  async refreshStale(
    sourceId: string,
    onProgress?: (done: number, total: number) => void,
    /** Only these deals (a link checked on its own), whatever their age. */
    focus?: string[],
  ): Promise<string[]> {
    const candidates = await this.deals.findMany({
      where: {
        and: [{ sourceId: { eq: sourceId } }, { status: { eq: "active" } }],
      },
    });
    const now = Date.now();
    const stale = candidates
      .filter((deal) => !focus || focus.includes(deal.id))
      .filter(
        (deal) =>
          !!focus ||
          ((deal.score ?? 0) >= MIN_SCORE_TO_CHECK &&
            (!deal.dealabsCheckedAt ||
              now - new Date(deal.dealabsCheckedAt).getTime() > CACHE_TTL_MS)),
      )
      // Closest to being published first: that's where history matters.
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .slice(0, SEARCHES_PER_RUN);

    for (const [index, deal] of stale.entries()) {
      onProgress?.(index + 1, stale.length);
      await this.refreshDeal(deal);
    }

    return stale.map((deal) => deal.id);
  }

  /**
   * The deals most likely to be posted next — highest Dealabs potential
   * among the visible ones — re-checked when their history is over
   * `maxAgeMs` old, so "already on Dealabs" (greyed cards) stays current
   * where it matters, not just every 24 h.
   * @returns ids of the deals re-checked.
   */
  async refreshTop(limit: number, maxAgeMs: number): Promise<string[]> {
    const now = Date.now();
    const top = (
      await this.deals.findMany({
        where: {
          and: [
            { status: { eq: "active" } },
            { score: { gte: MIN_VISIBLE_SCORE } },
          ],
        },
      })
    )
      .filter(
        (deal) =>
          !deal.dealabsCheckedAt ||
          now - new Date(deal.dealabsCheckedAt).getTime() > maxAgeMs,
      )
      .sort((a, b) => (b.hotChance ?? 0) - (a.hotChance ?? 0))
      .slice(0, limit);
    const done: string[] = [];
    for (const deal of top) {
      if (await this.refreshDeal(deal)) done.push(deal.id);
    }
    return done;
  }

  /** One deal's Dealabs history, searched again and stored. */
  protected async refreshDeal(deal: {
    id: string;
    title: string;
    currentPrice: number;
  }): Promise<boolean> {
    try {
      const threads = await this.search(dealabsQuery(deal.title));
      if (!threads) {
        // Blocked or down: don't mark as checked, retry next run.
        return false;
      }
      const me = this.env.DEALABS_USERNAME.toLowerCase();
      const isMine = (thread: DealabsThread) =>
        !!me && thread.poster?.toLowerCase() === me;
      // Our own posts are stored (tagged) so the console can show "Publié
      // par vous", but never count in the figures the score and the
      // prediction use: a deal would otherwise be its own "previous deal".
      const summary = summarizeDealabsHistory(
        threads.filter((thread) => !isMine(thread)),
        deal.title,
        deal.currentPrice,
      );
      const all = summarizeDealabsHistory(
        threads,
        deal.title,
        deal.currentPrice,
      );
      const stored: StoredDealabsDeal[] = all.deals.map((thread) => ({
        title: thread.title,
        price: thread.price,
        publishedAt: thread.publishedAt,
        temperature: Math.round(thread.temperature),
        isHot: thread.isHot,
        isExpired: thread.isExpired,
        merchant: thread.merchant,
        url: thread.url,
        ...(isMine(thread) ? { mine: true } : {}),
      }));
      await this.deals.updateById(deal.id, {
        dealabsLowestPrice: summary.lowest?.price,
        dealabsLowestAt: summary.lowest?.publishedAt,
        dealabsDealsCount: summary.deals.length,
        dealabsBestTemperature: summary.bestTemperature,
        // "" and not undefined: the ORM skips undefined, which kept an old
        // history (and a greyed card) after the deals were gone.
        dealabsHistory: stored.length ? JSON.stringify(stored) : "",
        dealabsCheckedAt: this.dateTime.nowISOString(),
      });
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.warn(`Dealabs history failed for "${deal.title}": ${message}`);
      return false;
    }
  }

  /**
   * One Dealabs request every SPACING_MS for the whole app: sources now
   * run in parallel, and each one's history lookups must not add up to a
   * burst against Dealabs.
   */
  protected nextSlot = 0;

  protected async waitTurn(): Promise<void> {
    const now = Date.now();
    const slot = Math.max(now, this.nextSlot);
    this.nextSlot = slot + SPACING_MS;
    if (slot > now) {
      await new Promise((resolve) => setTimeout(resolve, slot - now));
    }
  }

  /**
   * The live Dealabs deal this one would duplicate, if any (fresh search,
   * see `findLiveDuplicate`). `undefined` too when Dealabs didn't answer:
   * the publish then relies on the form's own duplicate warning.
   */
  async findLiveDuplicate(deal: {
    title: string;
    currentPrice: number;
  }): Promise<DealabsThread | undefined> {
    const threads = await this.search(dealabsQuery(deal.title));
    return threads
      ? findLiveDuplicate(threads, deal.title, deal.currentPrice)
      : undefined;
  }

  /** @returns the threads, or `undefined` when Dealabs didn't answer. */
  protected async search(query: string): Promise<DealabsThread[] | undefined> {
    await this.waitTurn();
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
