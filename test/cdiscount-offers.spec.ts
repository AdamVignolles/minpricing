import { describe, expect, test } from "vitest";

import { parseAmazonSignals } from "../src/api/collectors/amazonSignals.ts";
import {
  buildCdiscountDescription,
  cheapestCredibleOffer,
  parseCdiscountOffersLayer,
  parseComparisonPrice,
  parseOffersSummary,
  parseSellerLine,
  parseSplitEuro,
} from "../src/api/collectors/cdiscountOffers.ts";
import { titlesMatch } from "../src/api/services/MarketReferenceService.ts";

// Captured verbatim (innerText lines) from real Cdiscount offers layers.
const MARKETPLACE_LAYER = [
  "L’offre actuellement consultée",
  "379 €99",
  "Ajouter au panier",
  "Reconditionné - Excellent état",
  "?",
  "‌‌",
  "Expédié par :",
  "Cdiscount",
  "MIGANG",
  "4,4 / 5",
  "15824 ventes",
  "Livraison",
  "31 autres offres",
  "374 €94",
  "Ajouter au panier",
  "Reconditionné - Excellent état",
  "Expédié par :",
  "Cdiscount",
  "TechnoPort",
  "4,1 / 5",
  "6076 ventes",
  "Voir l'offre",
];

const CDISCOUNT_SOLD_LAYER = [
  "L’offre actuellement consultée",
  "60 €36",
  "Ajouter au panier",
  "‌‌",
  "Expédié par :",
  "CDISCOUNT",
  "Livraison",
  "3 autres offres",
  "59 €95",
  "Ajouter au panier",
  "Produit neuf",
  "‌‌",
  "Expédié par :",
  "SoldeurDuNet",
  "SoldeurDuNet",
  "2,7 / 5",
  "7354 ventes",
  "Voir l'offre",
  "69 €88",
  "Ajouter au panier",
  "Produit neuf",
  "Expédié par :",
  "GAMERS",
  "GAMERS",
  "4,4 / 5",
  "2562 ventes",
  "Voir l'offre",
];

describe("Cdiscount parsers", () => {
  test("split euro prices keep their cents", () => {
    expect(parseSplitEuro("379 €99")).toBe(379.99);
    expect(parseSplitEuro("1 299 €00")).toBe(1299);
    expect(parseSplitEuro("Ajouter au panier")).toBeUndefined();
  });

  test("marketplace seller: name, rating, sales, shipper", () => {
    const layer = parseCdiscountOffersLayer(MARKETPLACE_LAYER);
    expect(layer.current).toMatchObject({
      price: 379.99,
      sellerName: "MIGANG",
      shipper: "Cdiscount",
      sellerRating: 4.4,
      sellerSalesCount: 15824,
      condition: "refurbished",
    });
    expect(layer.othersCount).toBe(31);
    expect(layer.others[0]).toMatchObject({
      price: 374.94,
      sellerName: "TechnoPort",
      sellerRating: 4.1,
    });
  });

  test("Cdiscount-sold offer has no separate seller line", () => {
    const layer = parseCdiscountOffersLayer(CDISCOUNT_SOLD_LAYER);
    expect(layer.current).toMatchObject({
      price: 60.36,
      sellerName: "CDISCOUNT",
      shipper: "CDISCOUNT",
    });
    expect(layer.current?.sellerRating).toBeUndefined();
    expect(layer.others).toHaveLength(2);
  });

  test("a cheaper offer from a poorly rated seller doesn't count", () => {
    const layer = parseCdiscountOffersLayer(CDISCOUNT_SOLD_LAYER);
    // SoldeurDuNet (2,7/5) is cheaper but not credible; GAMERS (4,4/5) is.
    expect(cheapestCredibleOffer(layer.others, "new")?.price).toBe(69.88);
  });

  test("comparison price from the product page price block", () => {
    expect(
      parseComparisonPrice(
        "Prix de comparaison i 499,99 € 279 €99 dont 0.59€ d'éco part",
      ),
    ).toBe(499.99);
    expect(parseComparisonPrice("26 €99")).toBeUndefined();
  });

  test("seller line and offers summary", () => {
    expect(
      parseSellerLine(
        "Vendu par MIGANG et expédié par Cdiscount Expédié depuis nos entrepôts",
      ),
    ).toEqual({ sellerName: "MIGANG", shipper: "Cdiscount" });
    expect(parseSellerLine("Vendu et expédié par Cdiscount")).toEqual({
      sellerName: "Cdiscount",
      shipper: "Cdiscount",
    });
    expect(
      parseOffersSummary("32 offres d'occasion à partir de 374,94 €"),
    ).toEqual({
      offersCount: 32,
      fromPrice: 374.94,
    });
  });
});

describe("Amazon signals", () => {
  test("reads the 30-day low, seller, reviews, other sellers", () => {
    const details = parseAmazonSignals(
      {
        title: "Dreo Chauffage d'appoint",
        priceArea:
          "Offre à durée limitée 42,49 € avec 15 % d'économies -15 % Prix conseillé : 49,99 € Prix le plus bas des 30 derniers jours : 49,99€ 49,99€",
        ratingText: "4,6 sur 5 étoiles",
        reviewsText: "(10 447)",
        sellerText: "Amazon",
        buyBoxText: "Expéditeur / Vendeur Amazon Retours Retours de 14 jours",
        otherSellersText:
          "Autres vendeurs sur Amazon Neuf & D'occasion (4) dès 41,22€ 41 , 22€",
        boughtText: "Plus de 500 achetés au cours du mois dernier",
        basisText: "Prix conseillé : 49,99€ 49,99€",
      },
      42.49,
    );
    expect(details).toMatchObject({
      lowestRecentPrice: 49.99,
      sellerName: "Amazon",
      soldByMerchant: true,
      shippedByMerchant: true,
      productRating: 4.6,
      productReviewCount: 10447,
      recentPurchases: 500,
      offersCount: 5,
      listPriceKind: "rrp",
      condition: "new",
    });
    // "Neuf & D'occasion": the 41,22 € may be a used copy — not comparable.
    expect(details.bestOtherOfferPrice).toBeUndefined();
  });

  test("'5 k achetés' means 5000", () => {
    const details = parseAmazonSignals(
      {
        title: "x",
        priceArea: "",
        boughtText: "Plus de 5 k achetés au cours du mois dernier",
      },
      10,
    );
    expect(details.recentPurchases).toBe(5000);
  });
});

describe("cross-merchant title matching", () => {
  test("same product, different wording", () => {
    expect(
      titlesMatch(
        "EA SPORTS FC 27 - Jeu PS5",
        "EA SPORTS FC 27 Edition Standard PlayStation 5 |Disque I Jeu Vidéo |Français",
      ),
    ).toBe(true);
  });

  test("unrelated sponsored result", () => {
    expect(
      titlesMatch(
        "APPLE iPhone 15 128GB Black (2023)- Reconditionné",
        "Bougie d'Allumage pour NGK BPMR7A L7T et Champion CJ8",
      ),
    ).toBe(false);
  });
});

describe("Cdiscount description", () => {
  test("summary, strengths and useful specs — no boilerplate, no repeats", () => {
    const text = buildCdiscountDescription({
      summary:
        "Découvrez The World's Game dans EA SPORTS FC 27. Découvrez The Grounds, un terrain de jeu social. ".repeat(
          6,
        ),
      strengths: [
        "Points forts",
        "Version : En boîte",
        "Genre du jeu vidéo : Sport",
        "Voir le descriptif technique",
      ],
      specs: [
        ["Marque", "ELECTRONIC ARTS"],
        ["Nom du produit", "EA SPORTS FC 27 - Jeu PS5"],
        ["Plateforme", "PS5"],
        ["Version", "En boîte"],
        ["PEGI - Public", "16+"],
        [
          "Fabricant - Adresse postale",
          "1 Parkmore West Business Park, Galway",
        ],
        ["Opérateur économique responsable", "Electronic Arts Ireland"],
      ],
    });
    expect(text).toBeDefined();
    const [summary, strengths, specs] = (text as string).split("\n\n");
    expect(summary.length).toBeLessThanOrEqual(421);
    expect(summary.endsWith(".")).toBe(true);
    expect(strengths).toBe(
      "- Version : En boîte\n- Genre du jeu vidéo : Sport",
    );
    expect(specs).toContain("- Marque : ELECTRONIC ARTS");
    expect(specs).toContain("- Plateforme : PS5");
    expect(specs).toContain("- PEGI - Public : 16+");
    expect(specs).not.toMatch(/Nom du produit|Fabricant|Opérateur|Version/);
    expect(text).not.toMatch(/€/);
  });

  test("nothing on the page, no description", () => {
    expect(
      buildCdiscountDescription({ strengths: [], specs: [] }),
    ).toBeUndefined();
  });
});
