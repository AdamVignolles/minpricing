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
  /**
   * External "market reference price" (currently: Idealo's lowest listed
   * price across merchants), when available — see
   * {@link IdealoReferenceService}. Lets {@link ScoringService} reward a
   * deal that beats the wider market, not just our own price history.
   */
  referencePrice?: number;
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

  /**
   * How long an unchanged price may go unrecorded. Without this, a stable
   * price produces a single point ever, and the detail page's chart has
   * nothing to draw a line between — the history looked empty even on
   * deals tracked for weeks.
   */
  protected static readonly HEARTBEAT_MS = 24 * 60 * 60 * 1000;

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

    const previous = last[0];
    if (previous && previous.price === price) {
      const age =
        Date.now() - new Date(previous.observedAt as string | number).getTime();
      if (age < PricingService.HEARTBEAT_MS) {
        // Price unchanged and recorded recently: nothing to record.
        return;
      }
    }

    await this.history.create({
      dealId,
      price,
      currency,
      observedAt: this.dateTime.nowISOString(),
      source,
    });
  }

  async getStats(
    dealId: string,
    currentPrice: number,
    referencePrice?: number,
  ): Promise<PriceStats> {
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
      referencePrice,
    };
  }
}
