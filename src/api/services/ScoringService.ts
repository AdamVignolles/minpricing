import type { PriceStats } from "./PricingService.ts";

export type SourceReliability = "api" | "manual" | "scrape";

const RELIABILITY_WEIGHT: Record<SourceReliability, number> = {
  api: 1,
  manual: 0.7,
  scrape: 0.5,
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

    const score = discountTerm + newMinTerm + reliabilityTerm + confidenceTerm;

    return Math.round(Math.max(0, Math.min(100, score)));
  }
}
