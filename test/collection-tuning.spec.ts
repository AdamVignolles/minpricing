import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  resolveTargets,
  sourceDue,
} from "../src/api/services/collectionTuning.ts";

describe("resolveTargets", () => {
  it("adds only the enabled extra pages, without duplicates", () => {
    expect(
      resolveTargets(["a", "b"], 200, {
        extraPages: {
          on: { url: "c", enabled: true },
          off: { url: "d", enabled: false },
          dup: { url: "a", enabled: true },
        },
      }).urls,
    ).toEqual(["a", "b", "c"]);
  });

  it("clamps the tuned limit to its bounds", () => {
    expect(
      resolveTargets([], 200, { limit: 900, bounds: [150, 300] }).limit,
    ).toBe(300);
    expect(
      resolveTargets([], 200, { limit: 50, bounds: [150, 300] }).limit,
    ).toBe(150);
  });

  it("keeps the env defaults when there is no tuning", () => {
    expect(resolveTargets(["a"], 200, undefined)).toEqual({
      urls: ["a"],
      limit: 200,
    });
  });

  it("ships a valid config/collection.json", () => {
    const config = JSON.parse(readFileSync("config/collection.json", "utf8"));
    for (const shop of [config.amazon, config.cdiscount]) {
      expect(shop.limit).toBeGreaterThanOrEqual(shop.bounds[0]);
      expect(shop.limit).toBeLessThanOrEqual(shop.bounds[1]);
      for (const page of Object.values(shop.extraPages) as { url: string }[]) {
        expect(page.url).toMatch(
          /^https:\/\/www\.(amazon\.fr|cdiscount\.com)\//,
        );
      }
    }
  });
});

describe("sourceDue", () => {
  const now = new Date("2026-10-24T12:00:00Z").getTime();
  const hoursAgo = (h: number) => new Date(now - h * 3_600_000).toISOString();

  it("runs a source with no schedule every time", () => {
    expect(sourceDue("gog", hoursAgo(0.5), now, {}).due).toBe(true);
  });

  it("waits everyHours since the last success, with 10 min of slack", () => {
    const tuning = { sources: { orange: { everyHours: 12 } } };
    expect(sourceDue("orange", hoursAgo(5), now, tuning)).toEqual({
      due: false,
      reason: "not-yet",
    });
    expect(sourceDue("orange", hoursAgo(11.9), now, tuning).due).toBe(true);
    expect(sourceDue("orange", undefined, now, tuning).due).toBe(true);
  });

  it("caps everyHours at 24 h so deals never expire between runs", () => {
    const tuning = { sources: { epic: { everyHours: 200 } } };
    expect(sourceDue("epic", hoursAgo(24), now, tuning).due).toBe(true);
  });

  it("skips a switched-off source, never a locked one", () => {
    const tuning = {
      sources: { ikea: { enabled: false }, amazon: { enabled: false } },
      lockedSources: ["amazon"],
    };
    expect(sourceDue("ikea", hoursAgo(5), now, tuning)).toEqual({
      due: false,
      reason: "disabled",
    });
    expect(sourceDue("amazon", hoursAgo(5), now, tuning).due).toBe(true);
  });
});
