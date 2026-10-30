import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import {
  AmazonWatchCollector,
  WATCH_CATEGORIES,
} from "../src/api/collectors/AmazonWatchCollector.ts";
import {
  assessSilentDrop,
  categoriesForRun,
  parseBestSellers,
  readBestSellerPage,
  silentDrop,
  type WatchRunStats,
} from "../src/api/services/amazonWatch.ts";

const now = new Date("2026-10-21T12:00:00Z");
const daysAgo = (n: number) =>
  new Date(now.getTime() - n * 86_400_000).toISOString();

describe("silentDrop", () => {
  test("watched for less than 3 days: no verdict", () => {
    expect(
      silentDrop([{ price: 99.99, observedAt: daysAgo(1) }], 59.99, now),
    ).toBe(undefined);
  });

  test("a clear drop under the usual price and the month's low", () => {
    const drop = silentDrop(
      [
        { price: 99.99, observedAt: daysAgo(12) },
        { price: 94.99, observedAt: daysAgo(6) },
        { price: 99.99, observedAt: daysAgo(4) },
      ],
      79.99,
      now,
    );
    expect(drop).toMatchObject({ usualPrice: 99.99, monthLow: 94.99 });
    expect(drop?.days).toBeGreaterThanOrEqual(10);
  });

  test("its normal back-and-forth is not a drop", () => {
    // Usually 99,99 €, regularly at 79,99 €: 79,99 € today isn't news.
    const history = [
      { price: 99.99, observedAt: daysAgo(20) },
      { price: 79.99, observedAt: daysAgo(15) },
      { price: 99.99, observedAt: daysAgo(12) },
      { price: 74.99, observedAt: daysAgo(8) },
      { price: 99.99, observedAt: daysAgo(5) },
    ];
    expect(silentDrop(history, 79.99, now)).toBe(undefined);
  });

  test("a 9 999 € placeholder replaced by a real offer isn't a drop", () => {
    expect(
      silentDrop([{ price: 9999, observedAt: daysAgo(10) }], 2499, now),
    ).toBe(undefined);
  });

  test("too small to matter: under 15 % or 5 €", () => {
    const history = [{ price: 29.99, observedAt: daysAgo(10) }];
    expect(silentDrop(history, 26.99, now)).toBe(undefined);
    expect(
      silentDrop([{ price: 19.99, observedAt: daysAgo(10) }], 15.99, now),
    ).toBe(undefined);
  });
});

describe("parseBestSellers", () => {
  test("reads a best-seller card", () => {
    const html = `<div id="gridItemRoot"><div data-asin="B00NTCH52W">
      <span class="zg-bdg-text">#2</span>
      <img alt="Amazon Basics Lot de 20 piles AA" src="https://images-eu.ssl-images-amazon.com/x.jpg">
      <div class="_cDEzb_p13n-sc-css-line-clamp-3_g3dy1">Amazon Basics Lot de 20 piles alcalines AA</div>
      <i class="a-icon"><span>4,6 sur 5 étoiles</span></i><span class="a-size-small">937 080</span>
      <span class="_cDEzb_p13n-sc-price_3mJ9Z">8,79 €</span></div></div>`;
    expect(parseBestSellers(html)).toEqual([
      {
        asin: "B00NTCH52W",
        title: "Amazon Basics Lot de 20 piles alcalines AA",
        price: 8.79,
        url: "https://www.amazon.fr/dp/B00NTCH52W",
        imageUrl: "https://images-eu.ssl-images-amazon.com/x.jpg",
        rating: 4.6,
        reviewCount: 937080,
      },
    ]);
  });
});

const fixture = (name: string) =>
  readFileSync(
    join(import.meta.dirname, "fixtures/amazon-watch", name),
    "utf8",
  );

describe("readBestSellerPage (saved 2026-10 page)", () => {
  test("cards, prices, ratings, marketplace-only cards", () => {
    const page = readBestSellerPage(fixture("bestsellers-baby.html"));
    expect(page).toMatchObject({ cards: 30, noPrice: 11, captcha: false });
    expect(page.items).toHaveLength(19);
    expect(page.items.every((item) => item.rating && item.reviewCount)).toBe(
      true,
    );
    expect(page.items[0]).toMatchObject({
      asin: "B09TW72XZQ",
      price: 17.45,
      rating: 4.8,
      reviewCount: 55840,
    });
  });

  test("Amazon's robot check is recognised", () => {
    expect(readBestSellerPage(fixture("captcha.html"))).toEqual({
      items: [],
      cards: 0,
      noPrice: 0,
      captcha: true,
    });
  });
});

describe("assessSilentDrop: reasons and steadiness", () => {
  const at = (iso: string, price: number) => ({ price, observedAt: iso });

  test("a buy box swinging all day is not a drop (B0DYF82545, 2026-10)", () => {
    const series = [
      at("2026-10-27T16:00:00Z", 53.35),
      at("2026-10-27T17:00:00Z", 53.32),
      at("2026-10-27T20:00:00Z", 53.86),
      at("2026-10-27T21:00:00Z", 54.6),
      at("2026-10-28T07:00:00Z", 42.99),
      at("2026-10-28T08:00:00Z", 42.49),
      at("2026-10-28T14:00:00Z", 42.99),
      at("2026-10-29T04:00:00Z", 54.6),
      at("2026-10-29T09:00:00Z", 42.49),
      at("2026-10-29T14:00:00Z", 54.6),
      at("2026-10-29T21:00:00Z", 55.33),
      at("2026-10-30T11:00:00Z", 53.76),
      at("2026-10-30T12:00:00Z", 55.33),
    ];
    expect(
      assessSilentDrop(series, 42.49, new Date("2026-10-31T10:00:00Z")),
    ).toEqual({ reason: "unstable" });
  });

  test("a steady price that drops once is a drop", () => {
    const series = [
      at("2026-10-20T10:00:00Z", 59.99),
      at("2026-10-26T10:00:00Z", 59.99),
    ];
    expect(
      assessSilentDrop(series, 44.99, new Date("2026-10-31T10:00:00Z")),
    ).toMatchObject({ drop: { usualPrice: 59.99 } });
  });

  test("a slow decline is the new normal, not a drop", () => {
    const series = [
      at("2026-10-20T10:00:00Z", 100),
      at("2026-10-24T10:00:00Z", 95),
      at("2026-10-27T10:00:00Z", 90),
      at("2026-10-28T10:00:00Z", 86),
      at("2026-10-29T10:00:00Z", 82),
      at("2026-10-30T10:00:00Z", 80),
    ];
    expect(
      assessSilentDrop(series, 78, new Date("2026-10-31T10:00:00Z")),
    ).toHaveProperty("reason");
  });

  test("each rejection says why", () => {
    const now = new Date("2026-10-31T10:00:00Z");
    const steady = [at("2026-10-20T10:00:00Z", 29.99)];
    expect(assessSilentDrop([], 10, now)).toEqual({ reason: "too-young" });
    expect(assessSilentDrop(steady, 27.99, now)).toEqual({
      reason: "under-15pct",
    });
    expect(
      assessSilentDrop([at("2026-10-20T10:00:00Z", 19.99)], 15.99, now),
    ).toEqual({ reason: "under-5eur" });
    expect(assessSilentDrop(steady, 5, now)).toEqual({ reason: "implausible" });
  });
});

describe("categoriesForRun", () => {
  test("takes turns hour by hour and covers every category", () => {
    const seen = new Set<string>();
    for (let hour = 0; hour < 4; hour++) {
      const run = categoriesForRun(
        WATCH_CATEGORIES,
        4,
        new Date(Date.UTC(2026, 9, 30, hour)),
      );
      expect(run.length).toBeLessThanOrEqual(4);
      for (const category of run) seen.add(category);
    }
    expect(seen.size).toBe(WATCH_CATEGORIES.length);
  });
});

describe("AmazonWatchCollector run", () => {
  afterEach(() => vi.unstubAllGlobals());

  test("stops at the first robot check, skips cheap items, notes the run", async () => {
    const pages = [
      fixture("bestsellers-baby.html"),
      fixture("captcha.html"),
      fixture("bestsellers-baby.html"),
    ];
    const fetched: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        fetched.push(url);
        return new Response(pages[fetched.length - 1] ?? "", { status: 200 });
      }),
    );
    const observed: string[] = [];
    const watch = {
      knownToRead: async () => [],
      observe: async (items: Array<{ asin: string }>) => {
        observed.push(...items.map((item) => item.asin));
      },
      findDrops: async (items: unknown[], stats: WatchRunStats) => {
        stats.rejected["too-young"] = items.length;
        return [];
      },
    };
    const notes: string[] = [];
    const collector = new AmazonWatchCollector(
      watch as never,
      {} as never,
      undefined,
      {
        categoriesPerRun: 2,
        minPrice: 20,
        knownPerRun: 0,
        sleep: async () => {},
        now: () => new Date(Date.UTC(2026, 9, 30, 0)),
      },
    );
    const deals = await collector.discover({
      needsDetails: () => true,
      note: (message) => notes.push(message),
    });
    expect(deals).toEqual([]);
    // Page 1 read, page 2 a robot check: nothing more is requested.
    expect(fetched).toHaveLength(2);
    // Only the items worth 20 € or more are watched.
    const page = readBestSellerPage(fixture("bestsellers-baby.html"));
    const worth = page.items.filter((item) => item.price >= 20);
    expect(observed).toEqual(worth.map((item) => item.asin));
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("1 page(s) lue(s), 1 contrôle(s) anti-robot");
    expect(notes[0]).toContain("(lecture arrêtée au contrôle)");
    expect(notes[0]).toContain(
      `${page.items.length - worth.length} trop bon marché`,
    );
    expect(notes[0]).toContain(`moins de 3 jours de relevés ${worth.length}`);
  });
});

describe("formatWatchStats", () => {
  test("known products without a readable price are said so", async () => {
    const { formatWatchStats, emptyWatchStats } =
      await import("../src/api/services/amazonWatch.ts");
    const line = formatWatchStats({
      ...emptyWatchStats(["kitchen"]),
      knownRead: 2,
      knownFailed: 6,
    });
    expect(line).toContain(
      "produits connus relus 2, 6 sans prix lisible (indisponibles ou page refusée)",
    );
  });
});
