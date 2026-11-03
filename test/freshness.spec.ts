import { describe, expect, test } from "vitest";

import {
  freshnessOnUpdate,
  isRealPriceDrop,
} from "../src/api/services/freshness.ts";

describe("freshness", () => {
  test("only a real price drop makes a deal new again", () => {
    expect(isRealPriceDrop(29.99, 24.99)).toBe(true);
    // Same price, a rise, or noise (under 1 % or 0,50 €): not news.
    expect(isRealPriceDrop(29.99, 29.99)).toBe(false);
    expect(isRealPriceDrop(29.99, 34.99)).toBe(false);
    expect(isRealPriceDrop(29.99, 29.79)).toBe(false);
    expect(isRealPriceDrop(499, 495)).toBe(false);
    expect(isRealPriceDrop(4.99, 4.69)).toBe(false);
  });

  test("seen again unchanged: nothing to write; dropped: new date and old price", () => {
    const now = "2026-10-20T10:00:00.000Z";
    expect(freshnessOnUpdate(29.99, 29.99, now)).toBe(undefined);
    expect(freshnessOnUpdate(29.99, 24.99, now)).toEqual({
      freshAt: now,
      freshReason: "price-drop",
      droppedFrom: 29.99,
    });
  });

  test("back at the price it dropped from: the drop is undone", () => {
    const now = "2026-11-03T11:00:00.000Z";
    const current = {
      freshReason: "price-drop",
      droppedFrom: 31.99,
      firstSeenAt: "2026-10-27T17:23:30.640Z",
    };
    expect(freshnessOnUpdate(22.95, 32.4, now, current)).toEqual({
      freshAt: "2026-10-27T17:23:30.640Z",
      freshReason: "new",
    });
    // Still well under it: the drop stands.
    expect(freshnessOnUpdate(22.95, 27.99, now, current)).toBe(undefined);
    // A deal that never dropped is left alone.
    expect(
      freshnessOnUpdate(22.95, 32.4, now, { ...current, freshReason: "new" }),
    ).toBe(undefined);
  });
});
