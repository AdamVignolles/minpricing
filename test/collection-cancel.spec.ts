import { describe, expect, it } from "vitest";

import { mapWithConcurrency } from "../src/api/collectors/browser.ts";
import {
  isCollectionCancelled,
  setCollectionCancelled,
} from "../src/api/collectors/cancellation.ts";

describe("collection cancellation", () => {
  it("starts no new item once cancelled, finished ones are kept", async () => {
    setCollectionCancelled(false);
    const done: number[] = [];
    await mapWithConcurrency([1, 2, 3, 4, 5, 6], 2, async (n) => {
      done.push(n);
      if (n === 2) setCollectionCancelled(true);
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    expect(isCollectionCancelled()).toBe(true);
    expect(done.length).toBeLessThan(6);
    expect(done).toContain(1);
    setCollectionCancelled(false);
  });

  it("runs everything when not cancelled", async () => {
    setCollectionCancelled(false);
    const out = await mapWithConcurrency([1, 2, 3], 2, async (n) => n * 2);
    expect(out).toEqual([2, 4, 6]);
  });
});
