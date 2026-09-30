import { $inject } from "alepha";
import { DateTimeProvider } from "alepha/datetime";
import { $repository } from "alepha/orm";

import { priceHistoryEntity } from "../entities/PriceHistory.ts";

export interface PriceStats {
  currentPrice: number;
  minPrice: number;
  avgPrice: number;
  maxPrice: number;
  isNewHistoricalMin: boolean;
  historyPoints: number;
}

/**
 * Keeps the price history of a deal and derives simple statistics from it.
 *
 * A new row is only inserted when the price actually changed from the last
 * observation, so a product checked every 30 minutes for months does not
 * produce thousands of identical rows.
 */
export class PricingService {
  protected history = $repository(priceHistoryEntity);
  protected dateTime = $inject(DateTimeProvider);

  async recordObservation(
    dealId: string,
    price: number,
    currency: string,
    source: string,
  ): Promise<void> {
    const last = await this.history.findMany({
      where: { dealId: { eq: dealId } },
      orderBy: { column: "observedAt", direction: "desc" },
      limit: 1,
    });

    if (last[0] && last[0].price === price) {
      // Price unchanged since last observation: nothing to record.
      return;
    }

    await this.history.create({
      dealId,
      price,
      currency,
      observedAt: this.dateTime.nowISOString(),
      source,
    });
  }

  async getStats(dealId: string, currentPrice: number): Promise<PriceStats> {
    const rows = await this.history.findMany({
      where: { dealId: { eq: dealId } },
    });

    const prices = rows.map((row) => row.price);
    const minPrice = prices.length ? Math.min(...prices) : currentPrice;
    const maxPrice = prices.length ? Math.max(...prices) : currentPrice;
    const avgPrice = prices.length
      ? prices.reduce((sum, price) => sum + price, 0) / prices.length
      : currentPrice;

    return {
      currentPrice,
      minPrice: Math.min(minPrice, currentPrice),
      avgPrice,
      maxPrice,
      isNewHistoricalMin: currentPrice <= minPrice,
      historyPoints: prices.length,
    };
  }
}
