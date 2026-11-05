import { describe, expect, test } from "vitest";

import {
  buildDealFacts,
  type DealFactsInput,
  factFields,
  splitMerchantText,
} from "../src/api/services/dealFacts.ts";

const SEEN = "2026-11-04T10:00:00.000Z";
const DETAILS = "2026-11-04T07:07:04.376Z";

const base = (deal: Partial<DealFactsInput>): DealFactsInput => ({
  sourceId: "amazon",
  title: "x",
  url: "https://example.test/p",
  currentPrice: 10,
  lastSeenAt: SEEN,
  ...deal,
});

describe("splitMerchantText", () => {
  test("specs, bullets and paragraphs; a bullet with « : » stays a bullet", () => {
    const split = splitMerchantText(
      [
        "- Style tactile : une hybride à mi-chemin entre les switches linéaires et à cliquetis. Ne génère aucun clic mais le rebond tactile reste présent.",
        "- Configuration : Intel Core i5-10210U, 8 Go, 256 Go SSD",
        "- État : Correct",
        "Le jeu reste dans la bibliothèque.",
        "• Compatible RGB",
      ].join("\n"),
    );
    expect(split.specs).toEqual([
      {
        label: "Configuration",
        value: "Intel Core i5-10210U, 8 Go, 256 Go SSD",
      },
      { label: "État", value: "Correct" },
    ]);
    expect(split.bullets).toEqual([
      expect.stringMatching(/^Style tactile : une hybride/),
      "Compatible RGB",
    ]);
    expect(split.paragraphs).toEqual(["Le jeu reste dans la bibliothèque."]);
  });

  test("« Prix avec le code … » is not a spec", () => {
    expect(splitMerchantText("- Prix avec le code : LENOVO10").specs).toEqual(
      [],
    );
  });
});

describe("buildDealFacts by source family", () => {
  test("Amazon, sold by Amazon, with Dealabs history (Crucial DDR5)", () => {
    const facts = buildDealFacts(
      base({
        title:
          "Crucial Pro RAM DDR5 32Go Kit (2x16Go) 6000MHz CL36, Overclocking Gaming, Intel XMP 3.0 / AMD Expo, PC Mémoire, Noir - CP2K16G60C36U5B",
        url: "https://www.amazon.fr/dp/B0CTHXMYL8",
        imageUrl:
          "https://m.media-amazon.com/images/I/51EJt5geVEL._AC_SL800_.jpg",
        description:
          "- ASPECT NOIR ET TOUCHER AGRÉABLES: Notre mémoire DDR5 Pro Overclocking est dotée d’un dissipateur thermique noir en aluminium au design unique inspiré de l’origami\n- PERFORMANCES ACCÉLÉRÉES: 6000MHz à CL36 pour des performances d'overclocking stables",
        currentPrice: 499.99,
        listPrice: 549.99,
        sellerName: "Amazon",
        soldByMerchant: true,
        shippedByMerchant: true,
        offersCount: 21,
        productRating: 4.6,
        productReviewCount: 3902,
        recentPurchases: 400,
        condition: "new",
        detailsCheckedAt: DETAILS,
        dealabsLowestPrice: 221.36,
        dealabsLowestAt: "2025-12-06T17:36:03.000Z",
        dealabsDealsCount: 5,
        dealabsBestTemperature: 727.38,
        dealabsCheckedAt: "2026-11-02T10:29:30.548Z",
        availability: "in_stock",
      }),
      { merchantName: "Amazon" },
    );
    expect(facts.text.bullets?.value).toHaveLength(2);
    expect(facts.specs).toBeUndefined();
    expect(facts.seller?.soldByMerchant).toEqual({
      value: true,
      from: { via: "merchant", fields: ["soldByMerchant"], asOf: DETAILS },
    });
    expect(facts.reviews?.count?.value).toBe(3902);
    expect(facts.price.listed?.value).toEqual({
      price: 549.99,
      kind: undefined,
    });
    expect(facts.price.dealabs).toMatchObject({
      value: { lowestPrice: 221.36, postCount: 5, bestTemperature: 727.38 },
      from: { via: "dealabs", asOf: "2026-11-02T10:29:30.548Z" },
    });
    expect(facts.warnings).toEqual([]);
    expect(facts.product.merchant?.value).toBe("Amazon");
  });

  test("Amazon marketplace knock-off part (Makita-compatible batteries)", () => {
    const facts = buildDealFacts(
      base({
        title:
          "2Pièces 10.0Ah Remplacement pour Makita Batterie 18V | BL1860B BL1850B BL1840B Compatible avec les outils 18 V de la gamme LXT avec indicateur LED",
        currentPrice: 44.99,
        listPrice: 77.83,
        sellerName: "Zeroktek",
        soldByMerchant: false,
        productRating: 4.9,
        productReviewCount: 32,
        detailsCheckedAt: DETAILS,
      }),
    );
    expect(facts.warnings.map((w) => w.value)).toEqual([
      "marketplace-seller",
      "compatible-part",
    ]);
    expect(facts.warnings[1].from).toEqual({ via: "title", fields: ["title"] });
  });

  test("Cdiscount marketplace seller with an Amazon cross-check (Galaxy Tab)", () => {
    const facts = buildDealFacts(
      base({
        sourceId: "cdiscount",
        title: 'Tablette tactile Samsung Galaxy Tab A11+ 11" 256 Go Argent',
        currentPrice: 234.99,
        listPrice: 269.99,
        listPriceKind: "rrp",
        sellerName: "AoEn",
        soldByMerchant: false,
        sellerRating: 4.7,
        sellerSalesCount: 1250,
        productRating: 4.66,
        productReviewCount: 71,
        marketPrice: 309,
        marketPriceSource: "Amazon",
        marketPriceUrl: "https://www.amazon.fr/dp/X",
        marketCheckedAt: "2026-10-28T08:00:00.000Z",
        ean: "8806095000000",
        detailsCheckedAt: DETAILS,
      }),
    );
    expect(facts.price.listed?.value.kind).toBe("rrp");
    expect(facts.price.otherShops).toEqual({
      value: [
        { merchant: "Amazon", price: 309, url: "https://www.amazon.fr/dp/X" },
      ],
      from: {
        via: "cross-search",
        fields: ["marketPrice", "marketPriceSource", "marketPriceUrl"],
        asOf: "2026-10-28T08:00:00.000Z",
      },
    });
    expect(facts.seller?.salesCount?.value).toBe(1250);
    expect(facts.product.ean?.value).toBe("8806095000000");
    expect(facts.warnings.map((w) => w.value)).toEqual(["marketplace-seller"]);
  });

  test("other shops from the comparison table, cheapest first, bad rows dropped", () => {
    const facts = buildDealFacts(
      base({
        marketComparisons: JSON.stringify([
          { merchant: "Cdiscount", title: "t", price: 189, url: "https://c" },
          { merchant: "Amazon", title: "t", price: 175, url: "https://a" },
          { merchant: "Broken", price: 0 },
          { title: "no merchant", price: 12 },
        ]),
        marketPrice: 175,
        marketPriceSource: "Amazon",
      }),
    );
    expect(facts.price.otherShops?.value.map((s) => s.merchant)).toEqual([
      "Amazon",
      "Cdiscount",
    ]);
    expect(facts.price.otherShops?.from.fields).toEqual(["marketComparisons"]);
  });

  test("Amazon bullets that contain « : » stay bullets (Glorious switches)", () => {
    const facts = buildDealFacts(
      base({
        title: "Glorious Gaming 120x Gateron Brown",
        description:
          "- Style tactile : une hybride à mi-chemin entre les switches linéaires et à cliquetis. Ne génère aucun clic mais le rebond tactile reste présent.\n- Design hot swap : s’insère facilement dans les claviers mécaniques hot swap à prises PCB 3 ou 5 broches, sans nécessiter aucune soudure.",
        lowestRecentPrice: 42,
        detailsCheckedAt: DETAILS,
      }),
    );
    expect(facts.text.bullets?.value).toHaveLength(2);
    expect(facts.specs).toBeUndefined();
    expect(facts.price.lowest30d).toEqual({
      value: 42,
      from: { via: "merchant", fields: ["lowestRecentPrice"], asOf: DETAILS },
    });
  });

  test("listing-only shop with the title as only text (Screwfix DeWalt)", () => {
    const facts = buildDealFacts(
      base({
        sourceId: "screwfix",
        title:
          "Chaussures de sécurité SB P DEWALT Halogen Prolite marron pointure 43",
        currentPrice: 54.99,
        listPrice: 89.99,
        listPriceKind: "regular",
        lowestRecentPrice: 89.99,
        sellerName: "Screwfix",
        soldByMerchant: true,
      }),
    );
    expect(facts.text).toEqual({});
    expect(facts.specs).toBeUndefined();
    expect(facts.price.lowest30d?.value).toBe(89.99);
    expect(facts.warnings).toEqual([]);
  });

  test("watch shop without text, « prix conseillé » (Ocarat)", () => {
    const facts = buildDealFacts(
      base({
        sourceId: "ocarat",
        title: "Montre Edox Skydiver 38 Date Automatic Noire 80131-3NM-NIB",
        currentPrice: 739,
        listPrice: 1950,
        listPriceKind: "rrp",
        marketPrice: 1568,
        marketPriceSource: "Amazon",
      }),
    );
    expect(facts.text).toEqual({});
    expect(facts.price.listed?.value).toEqual({ price: 1950, kind: "rrp" });
    expect(facts.price.otherShops?.value[0]).toMatchObject({ price: 1568 });
  });

  test("Lenovo PC: specs from its text, coupon code, specs from the title", () => {
    const facts = buildDealFacts(
      base({
        sourceId: "lenovo",
        title:
          "Lenovo IdeaPad Slim 3 15IRH10 - Core i5-13420H - 16 Go RAM - 512 Go SSD",
        description:
          '- Écran : 15,3" WUXGA\n- Prix avec le code LENOVO10\n- Expédié sous 3 jours',
        currentPrice: 549,
        listPrice: 699,
      }),
    );
    expect(facts.isComputer).toBe(true);
    expect(facts.couponCode?.value).toBe("LENOVO10");
    expect(facts.specs?.value).toEqual([
      { label: "Écran", value: '15,3" WUXGA' },
      { label: "Processeur", value: "Core i5-13420H" },
      { label: "RAM", value: "16 Go" },
      { label: "Stockage", value: "512 Go" },
    ]);
    expect(facts.text.bullets?.value).toEqual([
      "Prix avec le code LENOVO10",
      "Expédié sous 3 jours",
    ]);
  });

  test("refurbished business laptop with a QWERTY keyboard (ITJustGood)", () => {
    const facts = buildDealFacts(
      base({
        sourceId: "itjustgood",
        title:
          'Reconditionné : PC Portable 14" Dell Latitude 3410 - Intel Core i5-10210U, RAM 8 Go, 256 Go SSD, Full HD, QWERTY',
        description:
          "- Configuration : Intel Core i5-10210U, 8 Go, 256 Go SSD\n- État : Correct\n- Reconditionné en France par ITJustGood",
        condition: "refurbished",
        currentPrice: 299.9,
        listPrice: 899,
        listPriceKind: "rrp",
      }),
    );
    expect(facts.warnings.map((w) => w.value)).toEqual([
      "keyboard-layout",
      "refurbished",
    ]);
    expect(facts.product.condition?.value).toBe("refurbished");
    // The merchant's « Configuration » already says CPU, RAM and storage:
    // nothing is repeated from the title.
    expect(facts.isComputer).toBe(true);
    expect(facts.specs?.value.map((s) => s.label)).toEqual([
      "Configuration",
      "État",
    ]);
  });

  test("Steam game: reviews, store text, historical low from a price service", () => {
    const facts = buildDealFacts(
      base({
        sourceId: "steam",
        title: "House Flipper",
        description: "Achetez, réparez et revendez des maisons.",
        currentPrice: 1.96,
        listPrice: 24.5,
        listPriceKind: "regular",
        productRating: 4.7,
        productReviewCount: 2254,
        historicalLowPrice: 1.96,
        historicalLowAt: "2026-10-27T00:00:00.000Z",
        historicalLowSource: "IsThereAnyDeal",
        itadCheckedAt: "2026-11-04T08:00:00.000Z",
      }),
    );
    expect(facts.text.paragraphs?.value).toEqual([
      "Achetez, réparez et revendez des maisons.",
    ]);
    expect(facts.price.historicalLow).toEqual({
      value: {
        price: 1.96,
        at: "2026-10-27T00:00:00.000Z",
        source: "IsThereAnyDeal",
      },
      from: {
        via: "price-history",
        fields: [
          "historicalLowPrice",
          "historicalLowAt",
          "historicalLowSource",
        ],
        asOf: "2026-11-04T08:00:00.000Z",
      },
    });
  });

  test("free game with an end date (Epic)", () => {
    const facts = buildDealFacts(
      base({
        sourceId: "epic",
        title: "Sorry We're Closed (PC, Epic Games Store)",
        currentPrice: 0,
        listPrice: 22.39,
        endDate: "2026-11-06T16:00:00.000Z",
        description:
          "Un jeu d'horreur rétro.\n\nGratuit à récupérer jusqu'au 06/11/2026, le jeu reste ensuite dans la bibliothèque.",
      }),
    );
    expect(facts.window?.value).toEqual({
      start: undefined,
      end: "2026-11-06T16:00:00.000Z",
    });
    expect(facts.text.paragraphs?.value).toHaveLength(2);
  });

  test("mobile plan billed per month, nothing invented (telecom)", () => {
    const facts = buildDealFacts(
      base({
        sourceId: "orange",
        title: "Forfait Mobile 200 Go 5G",
        currentPrice: 15.99,
        billingPeriod: "month",
        description: "- Appels, SMS et MMS illimités\n- 200 Go en 5G",
        sellerName: "Orange",
        soldByMerchant: true,
      }),
    );
    expect(facts.price.billingPeriod).toBe("month");
    expect(facts.price.listed).toBeUndefined();
    expect(facts.reviews).toBeUndefined();
    expect(facts.text.bullets?.value).toEqual([
      "Appels, SMS et MMS illimités",
      "200 Go en 5G",
    ]);
  });

  test("AliExpress shipped from abroad, out of stock", () => {
    const facts = buildDealFacts(
      base({
        sourceId: "aliexpress",
        title: "Smartphone POCO X7 Pro 12/256 Go",
        shipsFrom: "CN",
        availability: "out_of_stock",
        sellerName: "POCO Global Store",
        soldByMerchant: false,
      }),
    );
    expect(facts.warnings.map((w) => w.value)).toEqual([
      "marketplace-seller",
      "ships-from-abroad",
      "out-of-stock",
    ]);
    expect(facts.availability?.value).toBe("out_of_stock");
  });
});

describe("nothing is invented", () => {
  test("a bare row yields only title, url and price", () => {
    const facts = buildDealFacts(base({ title: "Produit", currentPrice: 12 }));
    expect(facts.text).toEqual({});
    expect(facts.seller).toBeUndefined();
    expect(facts.reviews).toBeUndefined();
    expect(facts.specs).toBeUndefined();
    expect(facts.warnings).toEqual([]);
    expect(facts.price.listed).toBeUndefined();
    expect(facts.price.otherShops).toBeUndefined();
    expect(factFields(facts).sort()).toEqual(["currentPrice", "title", "url"]);
  });

  test("a struck price not above the current price is not a fact", () => {
    const facts = buildDealFacts(base({ currentPrice: 20, listPrice: 20 }));
    expect(facts.price.listed).toBeUndefined();
  });

  test("every fact names stored columns", () => {
    const facts = buildDealFacts(
      base({
        title: "Lenovo IdeaPad 3 - Ryzen 5 - 16 Go RAM - 512 Go SSD",
        sellerName: "Amazon",
        soldByMerchant: true,
        productRating: 4.5,
        lowestRecentPrice: 600,
        marketPrice: 650,
        marketPriceSource: "Cdiscount",
      }),
    );
    for (const field of factFields(facts)) {
      expect(typeof field).toBe("string");
    }
    expect(factFields(facts)).toEqual(
      expect.arrayContaining([
        "sellerName",
        "lowestRecentPrice",
        "marketPrice",
        "title",
      ]),
    );
  });
});
