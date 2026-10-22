import { $inject } from "alepha";
import { DateTimeProvider } from "alepha/datetime";
import { $repository } from "alepha/orm";

import { dealEntity } from "../entities/Deal.ts";
import { priceHistoryEntity } from "../entities/PriceHistory.ts";
import {
  type Observation,
  type SilentDrop,
  silentDrop,
  type WatchedItem,
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
   * The watched products whose current price is a silent drop, biggest
   * drop first — minus those Amazon already shows as a promotion (the
   * regular Amazon source has them as an active deal).
   */
  async findDrops(
    items: WatchedItem[],
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
      const drop = silentDrop(byAsin.get(item.asin) ?? [], item.price, now);
      return drop ? [{ item, drop }] : [];
    });
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
    return drops
      .filter((d) => !promoted.has(d.item.asin))
      .sort(
        (a, b) =>
          b.drop.usualPrice / b.item.price - a.drop.usualPrice / a.item.price,
      );
  }
}
