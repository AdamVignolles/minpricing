import { describe, expect, test } from "vitest";

import {
  assessRealDrop,
  describeDrop,
  describeNoDrop,
  pastDips,
  type RealDrop,
} from "../src/api/services/priceDrop.ts";

const now = new Date("2026-11-09T12:00:00Z");
const daysAgo = (n: number) =>
  new Date(now.getTime() - n * 86_400_000).toISOString();
/** One observation a day, `prices[0]` the oldest, ending yesterday. */
const daily = (prices: number[]) =>
  prices.map((price, i) => ({
    price,
    observedAt: daysAgo(prices.length - i),
  }));
const repeat = (price: number, n: number) => Array(n).fill(price) as number[];

describe("assessRealDrop (epic 33)", () => {
  test("usually 100 €, now 75 €: a real drop against the usual price", () => {
    const verdict = assessRealDrop({
      price: 75,
      observations: daily(repeat(100, 20)),
      now,
    });
    expect(verdict).toMatchObject({
      drop: { reference: "usual", referencePrice: 100, percent: 25 },
    });
  });

  test("swings between 75 € and 100 € every month: 75 € is not a promotion", () => {
    const history = [
      ...repeat(100, 20),
      ...repeat(75, 6),
      ...repeat(100, 24),
      ...repeat(75, 6),
      ...repeat(100, 24),
    ];
    // Even with a real « was » price, the cycle wins.
    const verdict = assessRealDrop({
      price: 75,
      listPrice: 100,
      listPriceKind: "regular",
      observations: daily(history),
      now,
    });
    expect(verdict).toMatchObject({ reason: "usual-swing", times: 2 });
  });

  test("back to its usual price after a temporary rise: no promotion", () => {
    const verdict = assessRealDrop({
      price: 100,
      listPrice: 120,
      listPriceKind: "regular",
      observations: daily([...repeat(100, 20), ...repeat(120, 5)]),
      now,
    });
    expect(verdict).toMatchObject({ reason: "back-to-usual" });
  });

  test("a « prix conseillé » is never a reference", () => {
    expect(
      assessRealDrop({
        price: 49,
        listPrice: 149.9,
        listPriceKind: "rrp",
        observations: daily([49]),
        now,
      }),
    ).toMatchObject({ reason: "not-enough-history" });
  });

  test("Amazon's 30-day low decides at once, no history needed", () => {
    const verdict = assessRealDrop({
      price: 77.9,
      lowestRecentPrice: 99.9,
      listPrice: 129.9,
      listPriceKind: "rrp",
      observations: [],
      now,
    });
    expect(verdict).toMatchObject({
      drop: { reference: "amazon-30d-low", referencePrice: 99.9, percent: 22 },
    });
    expect(describeDrop((verdict as { drop: RealDrop }).drop)).toBe(
      "−22 % sous le prix le plus bas des 30 derniers jours (99,90 €)",
    );
  });

  test("added during the promotion: a flat history doesn't veto Amazon's low", () => {
    expect(
      assessRealDrop({
        price: 77.9,
        lowestRecentPrice: 99.9,
        observations: daily(repeat(77.9, 10)),
        now,
      }),
    ).toHaveProperty("drop");
  });

  test("Amazon's 30-day low first: at or above it, no drop", () => {
    expect(
      assessRealDrop({
        price: 99.9,
        lowestRecentPrice: 99.9,
        listPrice: 140,
        listPriceKind: "regular",
        observations: [],
        now,
      }),
    ).toMatchObject({ reason: "above-30d-low" });
  });

  test("a real former price counts, unless a week of history says it's the usual price", () => {
    expect(
      assessRealDrop({
        price: 14.99,
        listPrice: 23.99,
        listPriceKind: "regular",
        observations: daily([23.99, 23.99]),
        now,
      }),
    ).toMatchObject({ drop: { reference: "shop-was" } });
    expect(
      assessRealDrop({
        price: 14.99,
        listPrice: 23.99,
        listPriceKind: "regular",
        observations: daily(repeat(14.99, 10)),
        now,
      }),
    ).toMatchObject({ reason: "back-to-usual" });
  });

  test("small or tiny savings are not promotions", () => {
    expect(
      assessRealDrop({
        price: 90,
        lowestRecentPrice: 100,
        observations: [],
        now,
      }),
    ).toMatchObject({ reason: "under-15pct" });
    expect(
      assessRealDrop({
        price: 8,
        lowestRecentPrice: 12,
        observations: [],
        now,
      }),
    ).toMatchObject({ reason: "under-5eur" });
  });

  test("reasons in French", () => {
    expect(describeNoDrop({ reason: "not-enough-history", days: 6 })).toBe(
      "historique en cours (6 jours suivis)",
    );
    expect(describeNoDrop({ reason: "usual-swing", days: 80, times: 2 })).toBe(
      "fluctuation habituelle : déjà à ce prix 2 fois",
    );
  });
});

describe("pastDips", () => {
  test("the current dip is left out", () => {
    expect(pastDips([100, 75, 100, 75, 75], 75)).toBe(1);
    expect(pastDips([100, 100, 75], 75)).toBe(0);
  });
});
