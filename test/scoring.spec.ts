import { describe, expect, test } from "vitest";

import type { PriceStats } from "../src/api/services/PricingService.ts";
import { ScoringService } from "../src/api/services/ScoringService.ts";

const scoring = new ScoringService();

/** A deal seen once (the usual case for a freshly discovered offer). */
const firstSeen = (price: number): PriceStats => ({
  currentPrice: price,
  minPrice: price,
  avgPrice: price,
  maxPrice: price,
  isNewHistoricalMin: true,
  historyPoints: 1,
});

describe("ScoringService.evaluate", () => {
  test("criteria always add up to the score, max 100", () => {
    const result = scoring.evaluate(
      {
        currentPrice: 25.99,
        lowestRecentPrice: 64.99,
        listPrice: 64.99,
        listPriceKind: "rrp",
        sellerName: "Amazon",
        soldByMerchant: true,
        productRating: 4.2,
        productReviewCount: 4650,
      },
      firstSeen(25.99),
      "scrape",
    );
    const total = result.criteria.reduce((sum, c) => sum + c.points, 0);
    expect(Math.abs(total - result.score)).toBeLessThanOrEqual(1);
    expect(result.criteria.reduce((sum, c) => sum + c.max, 0)).toBe(100);
  });

  test("a real -60 % vs the 30-day low from Amazon itself scores high", () => {
    const result = scoring.evaluate(
      {
        currentPrice: 25.99,
        lowestRecentPrice: 64.99,
        sellerName: "Amazon",
        soldByMerchant: true,
        productRating: 4.2,
        productReviewCount: 4650,
      },
      firstSeen(25.99),
      "scrape",
    );
    expect(result.reference?.kind).toBe("lowest30d");
    expect(result.classification).toBe("excellent");
    expect(result.score).toBeGreaterThanOrEqual(70);
  });

  test("an inflated 'prix conseillé' is called out and barely counts", () => {
    const result = scoring.evaluate(
      {
        currentPrice: 42.49,
        listPrice: 99.99,
        listPriceKind: "rrp",
        lowestRecentPrice: 44,
      },
      firstSeen(42.49),
      "scrape",
    );
    // Measured against the trusted 30-day low (44 €), not the 99,99 € RRP.
    expect(result.reference?.kind).toBe("lowest30d");
    expect(result.reference?.discountPercentage).toBe(3);
    expect(result.warnings.join(" ")).toMatch(/gonflée/);
    expect(result.classification).toBe("average");
  });

  test("cheaper at another merchant → overpriced, with a warning", () => {
    const result = scoring.evaluate(
      { currentPrice: 64.99, marketPrice: 55, marketPriceSource: "Amazon" },
      firstSeen(64.99),
      "scrape",
    );
    expect(result.classification).toBe("overpriced");
    expect(result.criteria.find((c) => c.key === "competition")?.points).toBe(
      0,
    );
    expect(result.warnings.join(" ")).toMatch(/Moins cher ailleurs/);
  });

  test("same price as everywhere else is not a deal", () => {
    const result = scoring.evaluate(
      { currentPrice: 60.36, marketPrice: 60.36, marketPriceSource: "Amazon" },
      firstSeen(60.36),
      "scrape",
    );
    expect(result.classification).toBe("average");
    expect(result.verdict).not.toBe("excellent");
  });

  test("a poorly rated marketplace seller lowers the score and warns", () => {
    const base = { currentPrice: 300, lowestRecentPrice: 400 };
    const trusted = scoring.evaluate(
      { ...base, sellerName: "Cdiscount", soldByMerchant: true },
      firstSeen(300),
      "scrape",
    );
    const shady = scoring.evaluate(
      {
        ...base,
        sellerName: "SoldeurDuNet",
        soldByMerchant: false,
        sellerRating: 2.7,
        sellerSalesCount: 7354,
      },
      firstSeen(300),
      "scrape",
    );
    expect(shady.score).toBeLessThan(trusted.score - 10);
    expect(shady.warnings.join(" ")).toMatch(/SoldeurDuNet/);
  });

  test("no information at all is 'unknown', not 'bad'", () => {
    const result = scoring.evaluate(
      { currentPrice: 10 },
      firstSeen(10),
      "scrape",
    );
    expect(result.classification).toBe("unknown");
    expect(result.criteria.find((c) => c.key === "discount")?.status).toBe(
      "unknown",
    );
    // Neutral defaults keep it in the low-middle, never at 0.
    expect(result.score).toBeGreaterThan(15);
    expect(result.score).toBeLessThan(45);
  });

  test("our own history beats a generous 30-day low when it says otherwise", () => {
    const stats: PriceStats = {
      currentPrice: 25.99,
      minPrice: 25.99,
      avgPrice: 26.5,
      maxPrice: 27.99,
      isNewHistoricalMin: true,
      historyPoints: 6,
    };
    const result = scoring.evaluate(
      { currentPrice: 25.99, lowestRecentPrice: 64.99 },
      stats,
      "scrape",
    );
    // We've seen ~26 € for weeks: the honest discount is ~2 %, not 60 %.
    expect(result.reference?.kind).toBe("history");
    expect(result.reference?.discountPercentage).toBeLessThan(5);
  });
});
