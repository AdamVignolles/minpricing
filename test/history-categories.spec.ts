import { describe, expect, test } from "vitest";

import { interleave } from "../src/api/collectors/browser.ts";
import { cdiscountCategoryHint } from "../src/api/collectors/CdiscountCollector.ts";
import { buildSteamDescription } from "../src/api/collectors/SteamCollector.ts";
import { CategorizationService } from "../src/api/services/CategorizationService.ts";
import { describeFromTitle } from "../src/api/services/DealabsDraftService.ts";
import {
  dealabsQuery,
  isSameProduct,
  parseDealabsSearch,
  summarizeDealabsHistory,
} from "../src/api/services/dealabsSearch.ts";
import type { PriceStats } from "../src/api/services/PricingService.ts";
import { ScoringService } from "../src/api/services/ScoringService.ts";

/** A search result row as Dealabs embeds it (HTML-escaped JSON). */
const row = (thread: Record<string, unknown>) =>
  `<div data-vue3='${JSON.stringify({
    name: "ThreadMainListItemNormalizer",
    props: { thread },
  }).replace(/"/g, "&quot;")}'></div>`;

const SEARCH_HTML = [
  row({
    threadId: 1,
    title: "Lecteur multimédia Amazon Fire TV Stick 4K Plus",
    price: 23.99,
    nextBestPrice: 69.99,
    temperature: 711.3,
    isHot: true,
    isExpired: true,
    publishedAt: 1756800000,
    merchant: { merchantName: "Amazon" },
  }),
  row({
    threadId: 2,
    title: "Amazon Fire TV Stick 4K Max (Nouvelle génération)",
    price: 44.99,
    temperature: 240,
    isHot: true,
    isExpired: true,
    publishedAt: 1750550400,
    merchant: { merchantName: "Amazon" },
  }),
  row({
    threadId: 3,
    title: "Amazon Fire TV Stick 4K Plus (Frontalier Suisse)",
    price: 28,
    temperature: 837,
    isHot: true,
    isExpired: true,
    publishedAt: 1759449600,
  }),
  '<div data-vue3=\'{"name":"SomethingElse","props":{}}\'></div>',
].join("");

describe("Dealabs past deals", () => {
  test("parses the threads embedded in a search page", () => {
    const threads = parseDealabsSearch(SEARCH_HTML);
    expect(threads).toHaveLength(3);
    expect(threads[0]).toMatchObject({
      id: "1",
      price: 23.99,
      nextBestPrice: 69.99,
      isHot: true,
      merchant: "Amazon",
    });
  });

  test("query keeps the product name, not the marketing tail", () => {
    expect(
      dealabsQuery(
        "Amazon Fire TV Stick 4K Plus, avec prise en charge du Wi-Fi 6",
      ),
    ).toBe("Amazon Fire TV Stick 4K Plus");
  });

  test("variants and foreign stores are not the same product", () => {
    const ours = "Amazon Fire TV Stick 4K Plus, avec Wi-Fi 6";
    expect(
      isSameProduct(ours, 37.99, {
        title: "Lecteur multimédia Amazon Fire TV Stick 4K Plus",
        price: 23.99,
      }),
    ).toBe(true);
    expect(
      isSameProduct(ours, 37.99, {
        title: "Amazon Fire TV Stick 4K Max",
        price: 44.99,
      }),
    ).toBe(false);
    expect(
      isSameProduct(ours, 37.99, {
        title: "Amazon Fire TV Stick 4K Plus (Frontalier Suisse)",
        price: 28,
      }),
    ).toBe(false);
    // A Steam game's past deals: console versions and foreign stores out.
    const rdr = "Red Dead Redemption 2";
    expect(
      isSameProduct(rdr, 14.99, {
        title: "Red Dead Redemption 2 sur PC (Dématérialisé)",
        price: 13.5,
      }),
    ).toBe(true);
    expect(
      isSameProduct(rdr, 14.99, {
        title: "Red Dead Redemption 2 sur Xbox One & Series",
        price: 14.99,
      }),
    ).toBe(false);
    expect(
      isSameProduct(rdr, 14.99, {
        title: "Red Dead Redemption 2 - PS4",
        price: 19.99,
      }),
    ).toBe(false);
    expect(
      isSameProduct(rdr, 14.99, {
        title: "Red Dead Redemption 2",
        price: 13.57,
        merchant: "Amazon.es",
      }),
    ).toBe(false);
    // A plain "4K" past deal is no reference for our "4K Max".
    expect(
      isSameProduct("Amazon Fire TV Stick 4K Max", 52.99, {
        title: "Amazon Fire TV Stick 4K",
        price: 35.99,
      }),
    ).toBe(false);
  });

  test("summary keeps matching deals only, with the lowest one", () => {
    const summary = summarizeDealabsHistory(
      parseDealabsSearch(SEARCH_HTML),
      "Amazon Fire TV Stick 4K Plus",
      37.99,
    );
    expect(summary.deals.map((d) => d.id)).toEqual(["1"]);
    expect(summary.lowest?.price).toBe(23.99);
  });
});

describe("history criterion", () => {
  const scoring = new ScoringService();
  const stats: PriceStats = {
    currentPrice: 37.99,
    minPrice: 37.99,
    avgPrice: 37.99,
    maxPrice: 37.99,
    isNewHistoricalMin: true,
    historyPoints: 1,
  };
  const history = (signals: Parameters<ScoringService["evaluate"]>[0]) =>
    scoring.evaluate(signals, stats, "scrape");

  test("well above the lowest past deal: low points and a warning", () => {
    const result = history({
      currentPrice: 37.99,
      dealabsLowestPrice: 23.99,
      dealabsLowestAt: "2026-09-02T00:00:00.000Z",
      dealabsDealsCount: 10,
      dealabsBestTemperature: 711,
    });
    const criterion = result.criteria.find((c) => c.key === "history");
    expect(criterion?.status).toBe("bad");
    expect(criterion?.points).toBe(0);
    expect(result.warnings.join(" ")).toMatch(/Déjà vu nettement moins cher/);
  });

  test("matching the lowest past deal earns full points", () => {
    const result = history({ currentPrice: 23.99, dealabsLowestPrice: 23.99 });
    expect(result.criteria.find((c) => c.key === "history")?.points).toBe(10);
  });

  test("the lowest of Dealabs and the all-time low is the bar", () => {
    const result = history({
      currentPrice: 20,
      dealabsLowestPrice: 25,
      historicalLowPrice: 19.99,
      historicalLowSource: "IsThereAnyDeal (Steam)",
    });
    const criterion = result.criteria.find((c) => c.key === "history");
    expect(criterion?.detail).toMatch(/IsThereAnyDeal/);
    expect(criterion?.status).toBe("good");
  });
});

describe("categories from the merchant", () => {
  const categorization = new CategorizationService();

  test("Amazon deals collection and breadcrumb", () => {
    expect(categorization.fromHint("amazon:toys")).toBe("kids");
    expect(categorization.fromHint("amazon:lawn-and-garden")).toBe("diy");
    expect(categorization.fromHint("amazon-crumb:Cuisine et Maison")).toBe(
      "home",
    );
    expect(categorization.fromHint("amazon:all-deals")).toBeUndefined();
  });

  test("Cdiscount URL path", () => {
    const hint = cdiscountCategoryHint(
      "https://www.cdiscount.com/pret-a-porter/bebe-puericulture/poussette/f-123.html",
    );
    expect(hint).toBe("cdiscount:pret-a-porter/bebe-puericulture");
    expect(categorization.fromHint(hint)).toBe("kids");
    expect(
      categorization.fromHint(
        cdiscountCategoryHint("https://www.cdiscount.com/le-sport/x/f-1.html"),
      ),
    ).toBe("sport");
  });

  test("title fallback: LEGO is a toy, a treadmill is sport", () => {
    expect(
      categorization.classify(
        "LEGO Star Wars 75421 - Jeu Interactif dès 8 ans",
      ),
    ).toBe("kids");
    expect(categorization.classify("Tapis de course pliable - YEE RUN")).toBe(
      "sport",
    );
  });
});

describe("collection helpers", () => {
  test("interleave gives every page its share and drops duplicates", () => {
    expect(
      interleave([["a1", "a2", "a3"], ["b1", "a1"], ["c1"]], (x) => x),
    ).toEqual(["a1", "b1", "c1", "a2", "a3"]);
  });

  test("Steam description lists only facts Steam gave", () => {
    const text = buildSteamDescription(
      {
        summary: "Suivez votre chemin vers la vengeance.",
        genres: ["Action", "Aventure"],
        developers: ["FromSoftware, Inc."],
        publishers: ["Activision"],
        releaseDate: "21 mars 2019",
        metacritic: 88,
      },
      { productRating: 4.8, productReviewCount: 357183 },
    );
    expect(text).toContain("Suivez votre chemin");
    expect(text).toContain("Genres : Action, Aventure");
    expect(text).toContain(
      "Développeur : FromSoftware, Inc. · Éditeur : Activision",
    );
    expect(text).toContain("Sortie : 21 mars 2019");
    expect(text).toContain("96 % positifs");
    expect(text).toContain("Metacritic : 88/100");
  });
});

describe("draft description fallback", () => {
  test("a spec-laden title becomes a bullet list, never empty", () => {
    expect(
      describeFromTitle(
        "OOTD T10 - Trottinette électrique pliable - Moteur 900 W - Batterie 48 V 13,5 Ah - Roues de 11 pouces - Autonomie de 60 km - Noir",
      ),
    ).toBe(
      [
        "OOTD T10 - Trottinette électrique pliable",
        "- Moteur 900 W",
        "- Batterie 48 V 13,5 Ah",
        "- Roues de 11 pouces",
        "- Autonomie de 60 km",
        "- Noir",
      ].join("\n"),
    );
    expect(describeFromTitle("Red Dead Redemption 2")).toBe(
      "Red Dead Redemption 2",
    );
  });
});
