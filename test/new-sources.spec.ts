import { describe, expect, test } from "vitest";

import {
  modelQuery,
  parseCardBadges,
  parseReviewer,
} from "../src/api/collectors/aliexpressSignals.ts";
import { mapWithConcurrency } from "../src/api/collectors/browser.ts";
import { telecomTitle } from "../src/api/collectors/TelecomCollectors.ts";
import {
  parseBouyguesPlans,
  parseByouSeries,
  parseFreePlans,
  parseOrangePromos,
  parseRedPlans,
} from "../src/api/collectors/telecomOffers.ts";
import {
  isCollectionHour,
  nextCollectionTime,
} from "../src/api/jobs/CollectDealsJob.ts";
import { fitTitle } from "../src/api/services/CollectionService.ts";
import { matchesSameModel } from "../src/api/services/crossSearch.ts";
import { qualityIssue } from "../src/api/services/qualityGate.ts";
import { ScoringService } from "../src/api/services/ScoringService.ts";

// Shapes captured from the operators' real pages / API (trimmed).
const ORANGE_HTML = `
<div class="card-produit card ob1-push"><div class="card-body">
  <a href="https://boutique.orange.fr/mobile/offre/forfait-serie-speciale">
  <span class="ob1-tag">Bon plan</span>
  <h3 class="card-title"> Série Spéciale 130Go 5G+ </h3>
  <div class="lead">Profitez du meilleur de notre réseau mobile avec la 5G+</div>
  <div class="ob1-price"><span>20,99€</span><div>/mois</div></div>
  <del>24,99€</del>
  <div>Offre sans engagement</div>
  <div>Découvrir La Série Speciale 130Go 5G+</div></a>
</div></div>
<div class="card-produit card ob1-push"><div class="card-body">
  <a href="https://boutique.orange.fr/tv/netflix">
  <span>Offre découverte</span><h3>Netflix</h3>
  <div><span>10,99€</span><div>/mois</div></div></a>
</div></div>`;

const FREE_NEXT_DATA = {
  props: {
    pageProps: {
      goodDeals: { smartphonesTriptych: [] },
      serieFree: {
        id: 186,
        name: "Série Free",
        description: "160Go NAT / 30Go EUV / 5G",
        price: 1299,
        "5g": true,
        discount: [{ type: "migration", amount: 900, duration: 12 }],
      },
    },
  },
};

const BOUYGUES_API = {
  results: [
    {
      indexUid: "plans",
      hits: [
        {
          gencode: "1234",
          nom: "Confort 130Go 5G SIM Seule",
          gammeCommerciale: "forfait_sans_mobile",
          typePrix: "MENSUEL",
          libelleEnveloppeData: "130Go",
          connectivite: "5g",
          url: "confort-130go-5g-sim-seule-1234",
          prix: { initial: 22.99, pourToujours: 19.99, final: 19.99 },
        },
        {
          gencode: "1235",
          nom: "Confort 130Go 5G",
          gammeCommerciale: "forfait_avec_mobile",
          typePrix: "MENSUEL",
          prix: { initial: 22.99, final: 19.99 },
        },
      ],
    },
  ],
};

const RED_HTML = `<script>serviceOffer = { "id": "x", "data": { "redMobileOfferConfiguration": {
  "datanat": [
    { "enabled": true, "label": "40Go", "volume": 40000, "net5g": "disabled", "pricePerMonthWithDiscount": 999 },
    { "enabled": true, "label": "120Go", "volume": 120000, "net5g": "included", "pricePerMonthWithDiscount": 1299 },
    { "enabled": false, "label": "500Go", "volume": 500000, "pricePerMonthWithDiscount": 2999 }
  ] } } };</script>`;

describe("operator offers", () => {
  test("Orange: plans with their struck normal price, no streaming add-ons", () => {
    const offers = parseOrangePromos(ORANGE_HTML);
    expect(offers).toHaveLength(1);
    expect(offers[0]).toMatchObject({
      name: "Série Spéciale 130Go 5G+",
      price: 20.99,
      regularPrice: 24.99,
      kind: "mobile",
    });
  });

  test("Free: plan price in cents, conditional discounts only described", () => {
    const [offer] = parseFreePlans(FREE_NEXT_DATA);
    expect(offer).toMatchObject({ name: "Série Free", price: 12.99 });
    expect(offer.regularPrice).toBeUndefined();
    expect(offer.description).toContain("160Go NAT");
    expect(offer.description).toContain(
      "Remise de 9,00 €/mois en portabilité pendant 12 mois",
    );
  });

  test("Bouygues: SIM-only plans with normal and current price", () => {
    const offers = parseBouyguesPlans(BOUYGUES_API);
    expect(offers).toHaveLength(1);
    expect(offers[0]).toMatchObject({
      name: "Confort 130Go 5G",
      price: 19.99,
      regularPrice: 22.99,
    });
  });

  test("B&YOU special series from plain text", () => {
    const offers = parseByouSeries(
      "<p>Série spéciale B&amp;YOU 20Go 5G dont 20Go valables en Europe/DOM à 9,99€/mois</p>",
    );
    expect(offers[0]).toMatchObject({
      name: "Série spéciale B&YOU 20Go 5G",
      price: 9.99,
    });
  });

  test("RED: every enabled data option with its price", () => {
    const offers = parseRedPlans(RED_HTML);
    expect(offers.map((o) => [o.name, o.price])).toEqual([
      ["RED 40Go", 9.99],
      ["RED 120Go 5G", 12.99],
    ]);
  });

  test("titles don't repeat the brand or the kind", () => {
    const base = {
      externalId: "x",
      price: 1,
      url: "u",
      kind: "mobile" as const,
    };
    expect(telecomTitle({ ...base, name: "RED 40Go" }, "RED by SFR")).toBe(
      "Forfait mobile RED 40Go",
    );
    expect(telecomTitle({ ...base, name: "Série Free" }, "Free")).toBe(
      "Forfait mobile Série Free",
    );
    expect(
      telecomTitle({ ...base, name: "Confort 130Go 5G" }, "Bouygues Telecom"),
    ).toBe("Forfait mobile Bouygues Telecom Confort 130Go 5G");
    expect(
      telecomTitle(
        { ...base, kind: "pack", name: "Pack Internet + mobile" },
        "Orange",
      ),
    ).toBe("Orange Pack Internet + mobile");
  });
});

describe("AliExpress", () => {
  test("rating, review count and units sold from the reviewer line", () => {
    expect(parseReviewer("4.8 903 Avis ౹ + 5 000 vendus")).toEqual({
      rating: 4.8,
      reviews: 903,
      sold: 5000,
    });
    expect(parseReviewer("4.6 12 345 Avis ౹ + 10 000 vendus").reviews).toBe(
      12345,
    );
  });
});

describe("AliExpress cross-search", () => {
  test("model names from real AliExpress titles", () => {
    expect(
      modelQuery(
        "POCO X7 Pro 12GB+512GB｜8GB+256GB - Smartphone NFC Écran AMOLED",
      ),
    ).toBe("POCO X7 Pro");
    expect(
      modelQuery(
        "Smartphone Xiaomi Redmi Note 15 Pro 5G Version Globale MediaTek",
      ),
    ).toBe("Xiaomi Redmi Note 15 Pro");
    expect(
      modelQuery(
        "Mini PC CHUWI AuBox AMD R7 8745HS avec OCulink, 16 Go de RAM",
      ),
    ).toBe("CHUWI AuBox");
    // No-name products aren't cross-searched.
    expect(
      modelQuery("110 V/220 V chaîne extérieure lumières LED G40"),
    ).toBeUndefined();
  });

  test("same model only: variants, storage, accessories", () => {
    const ours =
      "Smartphone Xiaomi Redmi Note 14 Pro 5G Version Globale 8GB 256GB";
    const model = "Xiaomi Redmi Note 14 Pro";
    const match = (theirs: string) =>
      matchesSameModel(ours, model, theirs).match;
    expect(
      match(
        "Smartphone - XIAOMI - Redmi Note 14 Pro 5G - 8 Go RAM - 256 Go - Noir",
      ),
    ).toBe(true);
    expect(
      match("Smartphone XIAOMI Redmi Note 14 Pro+ 12GB RAM -512GB ROM 5G"),
    ).toBe(false);
    expect(
      match("Smartphone - XIAOMI - Redmi Note 14 5G - 8 Go RAM - 256 Go"),
    ).toBe(false);
    expect(match("Xiaomi Redmi Note 14 Pro 5G 12 Go 512 Go")).toBe(false);
    expect(match("Coque pour Xiaomi Redmi Note 14 Pro")).toBe(false);
  });

  test("a chip name or 'Mini PC' isn't a variant", () => {
    expect(
      matchesSameModel(
        "Smartphone Xiaomi Redmi Note 15 Pro 5G Version Globale MediaTek Dimensity 7400-Ultra",
        "Xiaomi Redmi Note 15 Pro",
        "Smartphone - XIAOMI - Redmi Note 15 Pro - 8 Go - 256 Go - 200 MP",
      ).match,
    ).toBe(true);
    expect(
      matchesSameModel(
        "Chuwi Ubox Mini PC AMD Ryzen 5 6600H 16 Go 512 Go SSD Windows 11 Pro",
        "Chuwi Ubox",
        "CHUWI UBox Mini PC Ryzen 5 6600H 16Go 512Go SSD Windows 11",
      ).match,
    ).toBe(true);
  });

  test("'Prix le plus bas en 90 jours' badge", () => {
    expect(
      parseCardBadges(["POCO", "319,2€", "Prix le plus bas en 90 jours"]),
    ).toEqual({
      lowestInDays: 90,
    });
  });

  test("AliExpress warnings: shipping, phone version, keyboard", () => {
    const scoring = new ScoringService();
    const stats = {
      currentPrice: 300,
      minPrice: 300,
      avgPrice: 300,
      maxPrice: 300,
      isNewHistoricalMin: true,
      historyPoints: 1,
    };
    const warn = (signals: Record<string, unknown>) =>
      scoring
        .evaluate(
          { currentPrice: 300, sourceId: "aliexpress", ...signals },
          stats,
          "scrape",
        )
        .warnings.join(" ");
    expect(
      warn({ title: "Smartphone POCO X7 Pro", categoryId: "phones" }),
    ).toMatch(/étranger.*version globale/s);
    expect(
      warn({
        title: "Smartphone POCO X7 Pro Version Globale",
        categoryId: "phones",
        shipsFrom: "FR",
      }),
    ).toBe("");
    expect(
      warn({ title: "Ordinateur portable Chuwi CoreBook", shipsFrom: "FR" }),
    ).toMatch(/QWERTY/);
  });
});

describe("collection schedule (Paris time)", () => {
  // October: Paris is UTC+2.
  const at = (parisHour: number) =>
    new Date(Date.UTC(2026, 9, 12, (parisHour - 2 + 24) % 24, 0));
  test("every hour from 8:00 to 23:00", () => {
    for (let hour = 8; hour <= 23; hour++) {
      expect(isCollectionHour(at(hour))).toBe(true);
    }
  });
  test("at night only 2:00 and 5:00 (every 3 hours after 23:00)", () => {
    const night = [0, 1, 2, 3, 4, 5, 6, 7].filter((hour) =>
      isCollectionHour(at(hour)),
    );
    expect(night).toEqual([2, 5]);
  });
  test("winter time too (Paris = UTC+1 in January)", () => {
    expect(isCollectionHour(new Date(Date.UTC(2027, 0, 15, 1, 0)))).toBe(true); // 2:00 Paris
    expect(isCollectionHour(new Date(Date.UTC(2027, 0, 15, 2, 0)))).toBe(false); // 3:00 Paris
  });
});

describe("long merchant titles", () => {
  test("cut to 300 characters at a word boundary", () => {
    const long = `Smartphone POCO X7 Pro ${"écran AMOLED charge rapide ".repeat(20)}fin`;
    const title = fitTitle(long);
    expect(title.length).toBeLessThanOrEqual(300);
    expect(title.endsWith("…")).toBe(true);
    expect(title).not.toMatch(/\s…$/);
    expect(fitTitle("POCO X7 Pro")).toBe("POCO X7 Pro");
  });
});

describe("next scheduled collection", () => {
  // October: Paris is UTC+2.
  const paris = (hour: number, minute = 0) =>
    new Date(Date.UTC(2026, 9, 12, hour - 2, minute));
  const parisHour = (date: Date) => (date.getUTCHours() + 2) % 24;
  test("next hour during the day", () => {
    expect(parisHour(nextCollectionTime(paris(10, 15)))).toBe(11);
  });
  test("after 23:00, the next one is at 2:00, then 5:00, then 8:00", () => {
    expect(parisHour(nextCollectionTime(paris(23, 20)))).toBe(2);
    expect(parisHour(nextCollectionTime(paris(2, 10)))).toBe(5);
    expect(parisHour(nextCollectionTime(paris(5, 30)))).toBe(8);
  });
});

describe("quality gate", () => {
  test("bad reviews, bad sellers and low-end laptops are turned away", () => {
    expect(
      qualityIssue({
        title: "Robot aspirateur",
        sourceId: "amazon",
        productRating: 3.6,
        productReviewCount: 120,
      }),
    ).toMatch(/produit mal noté/);
    expect(
      qualityIssue({
        title: "Chaussures",
        sourceId: "cdiscount",
        soldByMerchant: false,
        sellerRating: 2.7,
        sellerSalesCount: 7354,
      }),
    ).toMatch(/vendeur mal noté/);
    expect(
      qualityIssue({
        title: "Chaussures",
        sourceId: "cdiscount",
        soldByMerchant: false,
        sellerRating: 4.8,
        sellerSalesCount: 12,
      }),
    ).toMatch(/trop peu de ventes/);
    expect(
      qualityIssue({
        title: 'PC Portable 14" Bvate - N4020, 8 Go RAM',
        sourceId: "amazon",
      }),
    ).toMatch(/entrée de gamme/);
    expect(
      qualityIssue({
        title: "110 V/220 V chaîne extérieure lumières LED",
        sourceId: "aliexpress",
      }),
    ).toMatch(/sans marque/);
  });

  test("good offers and unknown facts pass", () => {
    expect(
      qualityIssue({
        title: "Lenovo IdeaPad Slim 3 - Ryzen 3",
        sourceId: "amazon",
        productRating: 4.4,
        productReviewCount: 900,
        soldByMerchant: true,
      }),
    ).toBeUndefined();
    // A rating on 3 reviews isn't enough to judge.
    expect(
      qualityIssue({
        title: "Tapis",
        sourceId: "cdiscount",
        productRating: 3,
        productReviewCount: 3,
      }),
    ).toBeUndefined();
    expect(
      qualityIssue({ title: "Sekiro", sourceId: "steam" }),
    ).toBeUndefined();
  });
});

describe("concurrency helper", () => {
  test("keeps order and never runs more than the limit at once", async () => {
    let running = 0;
    let peak = 0;
    const out = await mapWithConcurrency([5, 1, 4, 2, 3], 2, async (n) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, n * 5));
      running--;
      return n * 10;
    });
    expect(out).toEqual([50, 10, 40, 20, 30]);
    expect(peak).toBe(2);
  });
});
