import { describe, expect, test } from "vitest";

import {
  dealType,
  renderDescription,
} from "../src/api/services/dealDescription.ts";
import {
  buildDealFacts,
  type DealFactsInput,
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

const render = (
  deal: Partial<DealFactsInput>,
  context: { merchantName?: string; categoryName?: string } = {},
) => renderDescription(buildDealFacts(base(deal), context));

const CRUCIAL: Partial<DealFactsInput> = {
  title:
    "Crucial Pro RAM DDR5 32Go Kit (2x16Go) 6000MHz CL36, Overclocking Gaming, Intel XMP 3.0 / AMD Expo, PC Mémoire, Noir - CP2K16G60C36U5B",
  url: "https://www.amazon.fr/dp/B0CTHXMYL8",
  description:
    "- ASPECT NOIR ET TOUCHER AGRÉABLES: Notre mémoire DDR5 Pro Overclocking est dotée d’un dissipateur thermique noir en aluminium\n- PERFORMANCES ACCÉLÉRÉES: 6000MHz à CL36 pour des performances d'overclocking stables",
  currentPrice: 499.99,
  listPrice: 549.99,
  sellerName: "Amazon",
  soldByMerchant: true,
  shippedByMerchant: true,
  productRating: 4.6,
  productReviewCount: 3902,
  detailsCheckedAt: DETAILS,
  dealabsLowestPrice: 221.36,
  dealabsDealsCount: 5,
  dealabsBestTemperature: 727.38,
  dealabsCheckedAt: "2026-11-02T10:29:30.548Z",
  availability: "in_stock",
  extraFacts: JSON.stringify({
    specs: [
      { label: "Capacité de la mémoire", value: "32 Go" },
      { label: "Vitesse de la mémoire", value: "6000 MHz" },
    ],
    brand: "Crucial",
    returns: "Retournable sous 30 jours",
    delivery: "free",
  }),
};

describe("renderDescription by deal type", () => {
  test("Amazon product: highlights in sentence case, specs, seller block", () => {
    const rendered = render(CRUCIAL, { merchantName: "Amazon" });
    expect(rendered?.type).toBe("product");
    expect(rendered?.text).toBe(
      [
        "En bref :",
        "- Aspect noir et toucher agréables : Notre mémoire DDR5 Pro Overclocking est dotée d’un dissipateur thermique noir en aluminium",
        "- Performances accélérées : 6000MHz à CL36 pour des performances d'overclocking stables",
        "",
        "Caractéristiques :",
        "- Capacité de la mémoire : 32 Go",
        "- Vitesse de la mémoire : 6000 MHz",
        "",
        "Vendeur et livraison :",
        "- Vendu et expédié par Amazon",
        "- Note des acheteurs : 4,6/5 sur 3 902 avis",
        "- Livraison gratuite",
        "- Retournable sous 30 jours",
      ].join("\n"),
    );
    expect(rendered?.html).toContain(
      "<p><strong>Caractéristiques :</strong></p>",
    );
    expect(rendered?.html).toContain("<li>Capacité de la mémoire : 32 Go</li>");
  });

  test("marketplace knock-off part: third-party seller and notes", () => {
    const text = render(
      {
        title:
          "2Pièces 10.0Ah Remplacement pour Makita Batterie 18V | BL1860B BL1850B Compatible avec les outils 18 V",
        description: "- Haute capacité : 10.0Ah pour une autonomie prolongée",
        currentPrice: 44.99,
        sellerName: "Zeroktek",
        soldByMerchant: false,
        shippedByMerchant: true,
        sellerRating: 4.8,
        sellerSalesCount: 640,
        productRating: 4.9,
        productReviewCount: 32,
        detailsCheckedAt: DETAILS,
      },
      { merchantName: "Amazon" },
    )?.text;
    expect(text).toContain(
      "- Vendu par Zeroktek (vendeur tiers, 4,8/5 sur 640 ventes), expédié par Amazon",
    );
    expect(text).toContain("À savoir :");
    expect(text).toContain("- Pièce compatible, pas d'origine");
    // Already said in the seller block.
    expect(text).not.toContain("pas par Amazon");
  });

  test("Screwfix pick-up only offer says so", () => {
    const text = render(
      {
        sourceId: "screwfix",
        title: "Chaussures de sécurité DeWalt Hydrogen S3 pointure 43",
        currentPrice: 49.99,
        extraFacts: JSON.stringify({
          specs: [{ label: "Norme", value: "S3" }],
          storePickupOnly: true,
          warranty: "Garantie 1 an",
        }),
      },
      { merchantName: "Screwfix" },
    )?.text;
    expect(text).toContain("- Retrait en magasin uniquement (Click & Collect)");
    expect(text).toContain("- Norme : S3");
    expect(text).toContain("- Garantie 1 an");
  });

  test("Steam game: intro, game block, store specs once", () => {
    const rendered = render(
      {
        sourceId: "steam",
        title: "Hades",
        currentPrice: 9.99,
        listPrice: 24.5,
        sellerName: "Steam",
        soldByMerchant: true,
        description:
          "Défiez le dieu des morts.\n- Genres : Action, Indépendant\n- Développeur : Supergiant Games · Éditeur : Supergiant Games",
        extraFacts: JSON.stringify({
          specs: [
            { label: "Genre", value: "Action, Indépendant" },
            { label: "Développeur", value: "Supergiant Games" },
          ],
          platforms: ["Windows", "macOS"],
          languages: ["Textes en français"],
          features: ["Solo", "Succès Steam"],
        }),
      },
      { merchantName: "Steam" },
    );
    expect(rendered?.type).toBe("game");
    const text = rendered?.text ?? "";
    expect(text.split("\n")[0]).toMatch(/Windows, macOS.*Steam\.$/);
    expect(text).toContain("- Langue : textes en français");
    expect(text).toContain("- Fonctions : Solo, Succès Steam");
    expect(text.match(/Genre/g)).toHaveLength(1);
    expect(text.match(/Développeur/g)).toHaveLength(1);
    expect(text).not.toContain("Vendu et expédié par Steam");
  });

  test("free game: intro and end date", () => {
    const rendered = render(
      {
        sourceId: "epic",
        title: "Jeu offert : Control",
        currentPrice: 0,
        endDate: "2026-11-12T16:00:00.000Z",
        extraFacts: JSON.stringify({ platforms: ["Windows"] }),
      },
      { merchantName: "Epic Games Store" },
    );
    expect(rendered?.type).toBe("free-game");
    expect(rendered?.text).toMatch(/Epic Games Store\./);
    expect(rendered?.text).toContain(
      "- Gratuit jusqu'au 12/11/2026, le jeu reste ensuite dans la bibliothèque",
    );
  });

  test("mobile plan: intro and terms", () => {
    const rendered = render(
      {
        sourceId: "orange",
        title: "Forfait 100 Go",
        currentPrice: 9.99,
        billingPeriod: "month",
        extraFacts: JSON.stringify({
          planTerms: ["100 Go en 5G", "Sans engagement"],
        }),
      },
      { merchantName: "Orange" },
    );
    expect(rendered?.type).toBe("plan");
    expect(rendered?.text).toMatch(/Orange\./);
    expect(rendered?.text).toContain(
      "L'offre :\n- 100 Go en 5G\n- Sans engagement",
    );
  });

  test("coupon to activate, refurbished QWERTY laptop", () => {
    const text = render(
      {
        sourceId: "itjustgood",
        title: "Lenovo ThinkPad T14 Core i5-10210U 16 Go 512 Go SSD QWERTY",
        currentPrice: 299,
        condition: "refurbished",
        extraFacts: JSON.stringify({ coupon: "20 €" }),
      },
      { merchantName: "ITJustGood" },
    )?.text;
    expect(
      text?.startsWith("Pour obtenir le prix :\n- Activer le coupon de 20 €"),
    ).toBe(true);
    expect(text).toContain("- Produit reconditionné");
    expect(text).toMatch(/Clavier qwerty, pas AZERTY/i);
  });
});

describe("renderDescription guardrails", () => {
  test("never names DealRadar, a score, a heat chance or a price", () => {
    const text = render(
      { ...CRUCIAL, score: 87, hotChance: 52 },
      { merchantName: "Amazon" },
    )?.text;
    expect(text).not.toMatch(/dealradar|score|chance|°|499|549|221/i);
  });

  test("same deal, same text", () => {
    const a = render(CRUCIAL, { merchantName: "Amazon" });
    const b = render(CRUCIAL, { merchantName: "Amazon" });
    expect(a).toEqual(b);
  });

  test("long merchant texts are cut down to the length budget", () => {
    const long = Array.from(
      { length: 12 },
      (_, i) => `- Point ${i} : ${"détail ".repeat(40)}`,
    ).join("\n");
    const specs = Array.from({ length: 14 }, (_, i) => ({
      label: `Caractéristique ${i}`,
      value: `valeur ${i}`,
    }));
    const text =
      render(
        {
          ...CRUCIAL,
          description: long,
          extraFacts: JSON.stringify({ specs }),
        },
        { merchantName: "Amazon" },
      )?.text ?? "";
    expect(text.length).toBeLessThanOrEqual(2200);
    expect(text).toContain("Caractéristiques :");
  });

  test("nothing to say beyond an intro: undefined (title fallback)", () => {
    expect(render({ title: "Objet", currentPrice: 12 })).toBeUndefined();
  });

  test("dealType", () => {
    const facts = (deal: Partial<DealFactsInput>) => buildDealFacts(base(deal));
    expect(dealType(facts({ sourceId: "gog" }))).toBe("game");
    expect(dealType(facts({ sourceId: "freegames", currentPrice: 0 }))).toBe(
      "free-game",
    );
    expect(dealType(facts({ categoryId: "telecom" }))).toBe("plan");
    expect(dealType(facts({ sourceId: "cdiscount" }))).toBe("product");
  });
});

describe("Repères de prix (#129)", () => {
  const NOW = "2026-11-05T10:00:00.000Z";
  const priceLines = (
    deal: Partial<DealFactsInput>,
    context: { merchantName?: string } = {},
  ) =>
    renderDescription(buildDealFacts(base(deal), context), {
      now: NOW,
    })?.sections.find((section) => section.key === "price")?.lines;

  test("drop vs the shop's 30-day low, dated", () => {
    expect(
      priceLines(
        {
          currentPrice: 39.99,
          lowestRecentPrice: 59.99,
          detailsCheckedAt: "2026-11-05T07:00:00.000Z",
          description: "- Un point",
        },
        { merchantName: "Amazon" },
      ),
    ).toEqual([
      "Prix le plus bas des 30 derniers jours affiché par Amazon au 05/11 : 59,99 €, soit -33 %",
    ]);
  });

  test("the 30-day low wins: a bigger struck price is not used", () => {
    expect(
      priceLines({
        currentPrice: 50,
        lowestRecentPrice: 55,
        listPrice: 100,
        listPriceKind: "regular",
        detailsCheckedAt: "2026-11-05T07:00:00.000Z",
        description: "- Un point",
      }),
    ).toBeUndefined();
  });

  test("Steam's regular price; never a « prix conseillé », never our measure", () => {
    const steam = {
      sourceId: "steam",
      currentPrice: 9.99,
      listPrice: 24.5,
      listPriceKind: "regular" as const,
      description: "- Un point",
    };
    expect(priceLines(steam, { merchantName: "Steam" })).toEqual([
      "Prix habituel affiché par Steam au 04/11 : 24,50 €, soit -59 %",
    ]);
    expect(priceLines({ ...steam, listPriceKind: "rrp" })).toBeUndefined();
    expect(priceLines({ ...steam, listPriceKind: undefined })).toBeUndefined();
    expect(priceLines({ ...steam, sourceId: "amazon-watch" })).toBeUndefined();
  });

  test("a drop under 20 % is no argument", () => {
    expect(
      priceLines({
        sourceId: "steam",
        currentPrice: 20,
        listPrice: 24,
        listPriceKind: "regular",
        description: "- Un point",
      }),
    ).toBeUndefined();
  });

  test("other shops: ≥ 10 % cheaper and read in the last 24 h", () => {
    const deal = {
      sourceId: "cdiscount",
      currentPrice: 234.99,
      marketComparisons: JSON.stringify([
        { merchant: "Fnac", price: 329 },
        { merchant: "Amazon", price: 309 },
      ]),
      marketCheckedAt: "2026-11-05T06:00:00.000Z",
      description: "- Un point",
    };
    expect(priceLines(deal)).toEqual([
      "Ailleurs au 05/11 : Amazon 309 €, Fnac 329 €",
    ]);
    expect(
      priceLines({ ...deal, marketCheckedAt: "2026-11-03T06:00:00.000Z" }),
    ).toBeUndefined();
    expect(priceLines({ ...deal, currentPrice: 290 })).toBeUndefined();
  });

  test("lower than ever posted on Dealabs; historical low", () => {
    expect(
      priceLines({
        sourceId: "nintendo",
        currentPrice: 29.99,
        dealabsLowestPrice: 34.99,
        dealabsLowestAt: "2025-12-06T17:36:03.000Z",
        dealabsDealsCount: 3,
        dealabsCheckedAt: "2026-11-05T01:00:00.000Z",
        historicalLowPrice: 29.99,
        historicalLowAt: "2025-03-01T00:00:00.000Z",
        historicalLowSource: "DekuDeals",
        itadCheckedAt: "2026-11-05T02:00:00.000Z",
        description: "- Un point",
      }),
    ).toEqual([
      "Plus bas prix déjà partagé sur Dealabs : 34,99 € (le 06/12/2025)",
      "Égal au plus bas historique relevé par DekuDeals (29,99 € le 01/03/2025)",
    ]);
  });

  test("stale or missing dates: nothing printed", () => {
    expect(
      priceLines({
        currentPrice: 39.99,
        lowestRecentPrice: 59.99,
        detailsCheckedAt: "2026-11-01T07:00:00.000Z",
        dealabsLowestPrice: 50,
        dealabsDealsCount: 2,
        description: "- Un point",
      }),
    ).toBeUndefined();
  });

  test("operators stored by id are named", () => {
    expect(
      priceLines({
        sourceId: "sfr",
        currentPrice: 15.99,
        billingPeriod: "month",
        marketComparisons: JSON.stringify([
          { merchant: "free", price: 19.99 },
          { merchant: "bouygues", price: 44.99 },
        ]),
        marketCheckedAt: "2026-11-05T06:00:00.000Z",
        description: "- 250 Go en 5G",
      }),
    ).toEqual([
      "Ailleurs au 05/11 : Free 19,99 €/mois, Bouygues Telecom 44,99 €/mois",
    ]);
  });

  test("monthly plans say « /mois »", () => {
    expect(
      priceLines({
        sourceId: "free",
        currentPrice: 9.99,
        billingPeriod: "month",
        marketPrice: 15.99,
        marketPriceSource: "Orange",
        marketCheckedAt: "2026-11-05T06:00:00.000Z",
        extraFacts: JSON.stringify({ planTerms: ["100 Go"] }),
      }),
    ).toEqual(["Ailleurs au 05/11 : Orange 15,99 €/mois"]);
  });

  test("without a render time, no price section at all", () => {
    expect(
      renderDescription(
        buildDealFacts(
          base({
            sourceId: "steam",
            currentPrice: 9.99,
            listPrice: 24.5,
            listPriceKind: "regular",
            description: "- Un point",
          }),
        ),
      )?.text,
    ).not.toMatch(/€/);
  });
});
