import { $inject } from "alepha";
import { DateTimeProvider } from "alepha/datetime";
import { $repository } from "alepha/orm";

import { dealEntity } from "../entities/Deal.ts";
import { priceHistoryEntity } from "../entities/PriceHistory.ts";
import {
  assessSilentDrop,
  type Observation,
  type SilentDrop,
  type WatchedItem,
  type WatchRunStats,
} from "./amazonWatch.ts";
import { PricingService } from "./PricingService.ts";

const KEY_PREFIX = "watch:";

/**
 * The tracker behind `AmazonWatchCollector`: records the watched products'
 * prices in `PriceHistory` (key `watch:<ASIN>`, only on change plus a daily
 * heartbeat) and finds the silent drops (see `amazonWatch.ts`).
 */
export class AmazonWatchService {
  protected dateTime = $inject(DateTimeProvider);
  protected pricing = $inject(PricingService);
  protected history = $repository(priceHistoryEntity);
  protected deals = $repository(dealEntity);

  async observe(items: WatchedItem[]): Promise<void> {
    for (const item of items) {
      await this.pricing.recordObservation(
        `${KEY_PREFIX}${item.asin}`,
        item.price,
        "EUR",
        "amazon-watch",
      );
    }
  }

  /**
   * Products we already know matter, beyond the best sellers: Amazon deals
   * that are over (expired or archived in the last 60 days, from the
   * Amazon, relaunch and silent-drop sources), worth at least `minPrice`.
   * `perRun` of them per run, taking turns hour by hour, so each is read
   * every few hours on its own product page.
   */
  async knownToRead(
    perRun: number,
    minPrice: number,
    exclude: Set<string>,
  ): Promise<Array<{ asin: string; title: string }>> {
    if (perRun <= 0) return [];
    const now = new Date(this.dateTime.nowISOString());
    const since = new Date(now.getTime() - 60 * 86_400_000).toISOString();
    const deals = await this.deals.findMany({
      where: {
        and: [
          { sourceId: { inArray: ["amazon", "relances", "amazon-watch"] } },
          { status: { inArray: ["expired", "archived"] } },
          { lastSeenAt: { gte: since } },
          { currentPrice: { gte: minPrice } },
        ],
      },
    });
    const byAsin = new Map<string, { asin: string; title: string }>();
    for (const deal of deals) {
      if (
        /^[A-Z0-9]{10}$/.test(deal.externalId) &&
        !exclude.has(deal.externalId)
      ) {
        byAsin.set(deal.externalId, {
          asin: deal.externalId,
          title: deal.title,
        });
      }
    }
    const known = [...byAsin.values()].sort((a, b) =>
      a.asin.localeCompare(b.asin),
    );
    if (known.length <= perRun) return known;
    const turns = Math.ceil(known.length / perRun);
    const turn = Math.floor(now.getTime() / 3_600_000) % turns;
    return known.slice(turn * perRun, turn * perRun + perRun);
  }

  /**
   * The watched products whose current price is a silent drop, biggest
   * drop first — minus those Amazon already shows as a promotion (the
   * regular Amazon source has them as an active deal).
   */
  async findDrops(
    items: WatchedItem[],
    stats?: WatchRunStats,
  ): Promise<Array<{ item: WatchedItem; drop: SilentDrop }>> {
    const now = new Date(this.dateTime.nowISOString());
    const since = new Date(now.getTime() - 31 * 86_400_000).toISOString();
    const rows = await this.history.findMany({
      where: {
        and: [
          { dealId: { startsWith: KEY_PREFIX } },
          { observedAt: { gte: since } },
        ],
      },
    });
    const byAsin = new Map<string, Observation[]>();
    for (const row of rows) {
      const asin = row.dealId.slice(KEY_PREFIX.length);
      const list = byAsin.get(asin) ?? [];
      list.push({
        price: row.price,
        observedAt: new Date(row.observedAt as string | number).toISOString(),
      });
      byAsin.set(asin, list);
    }

    const drops = items.flatMap((item) => {
      const verdict = assessSilentDrop(
        byAsin.get(item.asin) ?? [],
        item.price,
        now,
      );
      if ("drop" in verdict) return [{ item, drop: verdict.drop }];
      if (stats) {
        stats.rejected[verdict.reason] =
          (stats.rejected[verdict.reason] ?? 0) + 1;
      }
      return [];
    });
    if (stats) stats.drops = drops.length;
    if (drops.length === 0) return [];

    const promoted = new Set(
      (
        await this.deals.findMany({
          where: {
            and: [
              { sourceId: { eq: "amazon" } },
              { status: { eq: "active" } },
              { externalId: { inArray: drops.map((d) => d.item.asin) } },
            ],
          },
        })
      ).map((deal) => deal.externalId),
    );
    if (stats) stats.promoted = promoted.size;
    return drops
      .filter((d) => !promoted.has(d.item.asin))
      .sort(
        (a, b) =>
          b.drop.usualPrice / b.item.price - a.drop.usualPrice / a.item.price,
      );
  }
}
