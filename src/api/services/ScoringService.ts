import type { PriceStats } from "./PricingService.ts";

export type SourceReliability = "api" | "manual" | "scrape";

const RELIABILITY_WEIGHT: Record<SourceReliability, number> = {
  api: 1,
  manual: 0.7,
  scrape: 0.5,
};

/**
 * A plain-language verdict on how good a deal actually is, derived from
 * the very same comparisons {@link ScoringService.computeScore} already
 * makes — so the badge shown to the user can never disagree with the
 * numeric score behind it.
 *
 * - `excellent` / `good` / `average` / `overpriced`: a reference price was
 *   available (market, when present, otherwise our own history) to compare
 *   against.
 * - `unknown`: fewer than 2 price observations and no market reference —
 *   there is nothing yet to compare the current price to.
 */
export type DealClassification =
  | "excellent"
  | "good"
  | "average"
  | "overpriced"
  | "unknown";

const MARKET_THRESHOLDS = {
  excellent: 0.9, // at least 10% below the market reference price
  good: 0.98, // at least 2% below it
  average: 1.03, // within 3% of it either way counts as "the normal price"
};

const HISTORY_THRESHOLDS = {
  // Percent gap vs our own historical average (negative = cheaper).
  good: -5,
  overpriced: 5,
};

/**
 * Computes a 0-100 relevance score for a deal, based on price history
 * rather than the "old price" a source claims. Explainable on purpose:
 * each term below is a named, capped contribution, not a black box.
 */
export class ScoringService {
  computeScore(stats: PriceStats, reliability: SourceReliability): number {
    const discountVsAverage =
      stats.avgPrice > 0
        ? Math.max(0, (stats.avgPrice - stats.currentPrice) / stats.avgPrice)
        : 0;

    const discountTerm = 40 * Math.min(discountVsAverage, 1);
    const newMinTerm = stats.isNewHistoricalMin ? 30 : 0;
    const reliabilityTerm = 20 * RELIABILITY_WEIGHT[reliability];
    const confidenceTerm = 10 * Math.min(stats.historyPoints / 10, 1);

    // Bonus, not part of the base 100: our own price history is thin (a
    // handful of tracked products), so it can't always tell a real deal
    // from a product that has simply always been priced that way. When an
    // external market reference price is available (Idealo's lowest price
    // across merchants, see IdealoReferenceService), reward beating that
    // wider market too. Zero, and the score is unchanged, when no
    // reference price could be obtained — most products won't have one.
    const discountVsMarket =
      stats.referencePrice && stats.referencePrice > 0
        ? Math.max(
            0,
            (stats.referencePrice - stats.currentPrice) / stats.referencePrice,
          )
        : 0;
    const marketTerm = 20 * Math.min(discountVsMarket, 1);

    const score =
      discountTerm + newMinTerm + reliabilityTerm + confidenceTerm + marketTerm;

    return Math.round(Math.max(0, Math.min(100, score)));
  }

  /**
   * Classifies how the current price compares to "normal" pricing:
   * against the external market reference price when one is available
   * (Idealo), otherwise against our own price history. Never against the
   * merchant's own struck-through "prix barré" — that one is theirs to
   * inflate, not ours to trust.
   */
  classifyDeal(stats: PriceStats): DealClassification {
    if (stats.referencePrice && stats.referencePrice > 0) {
      const ratio = stats.currentPrice / stats.referencePrice;
      if (ratio <= MARKET_THRESHOLDS.excellent) return "excellent";
      if (ratio <= MARKET_THRESHOLDS.good) return "good";
      if (ratio <= MARKET_THRESHOLDS.average) return "average";
      return "overpriced";
    }

    if (stats.historyPoints < 2) {
      return "unknown";
    }
    if (stats.isNewHistoricalMin) {
      return "excellent";
    }
    if (stats.avgPrice > 0) {
      const vsAveragePercentage =
        ((stats.currentPrice - stats.avgPrice) / stats.avgPrice) * 100;
      if (vsAveragePercentage <= HISTORY_THRESHOLDS.good) return "good";
      if (vsAveragePercentage >= HISTORY_THRESHOLDS.overpriced) {
        return "overpriced";
      }
    }
    return "average";
  }
}
