import { describe, expect, test } from "vitest";

import {
  parseEpicFreeGames,
  parseEuro,
  parseGogCatalog,
  parseIkeaOffers,
  parseLidlSearch,
  parseNintendoSearch,
  parsePlayStationGrid,
  parseXboxDeals,
} from "../src/api/collectors/storeOffers.ts";

describe("parseEuro", () => {
  test("store formats", () => {
    expect(parseEuro("€48,99")).toBe(48.99);
    expect(parseEuro("1 049,00 €")).toBe(1049);
    expect(parseEuro("29.99")).toBe(29.99);
    expect(parseEuro("Gratuit")).toBe(undefined);
  });
});

describe("parseEpicFreeGames", () => {
  const game = (discountPrice: number, start: string, end: string) => ({
    id: "abc",
    title: "TerraScape",
    catalogNs: { mappings: [{ pageSlug: "terrascape-2b12b1" }] },
    keyImages: [{ type: "OfferImageWide", url: "https://img/wide.jpg" }],
    price: { totalPrice: { originalPrice: 1529, discountPrice } },
    promotions: {
      promotionalOffers: [
        { promotionalOffers: [{ startDate: start, endDate: end }] },
      ],
    },
  });
  const json = (elements: unknown[]) => ({
    data: { Catalog: { searchStore: { elements } } },
  });
  const now = new Date("2026-10-12T12:00:00Z");

  test("a game free right now", () => {
    const [deal] = parseEpicFreeGames(
      json([game(0, "2026-10-08T15:00:00Z", "2026-10-15T15:00:00Z")]),
      now,
    );
    expect(deal).toMatchObject({
      price: 0,
      listPrice: 15.29,
      url: "https://store.epicgames.com/fr/p/terrascape-2b12b1",
      categoryId: "video-games",
    });
  });

  test("not free, or not yet: nothing", () => {
    expect(
      parseEpicFreeGames(
        json([
          game(999, "2026-10-08T15:00:00Z", "2026-10-15T15:00:00Z"),
          game(0, "2026-10-15T15:00:00Z", "2026-10-22T15:00:00Z"),
        ]),
        now,
      ),
    ).toEqual([]);
  });
});

describe("parseGogCatalog", () => {
  test("price, regular price and a 0-50 rating", () => {
    const [deal] = parseGogCatalog({
      products: [
        {
          id: "1",
          slug: "heroes",
          title: "Heroes 3",
          storeLink: "https://www.gog.com/fr/game/heroes",
          reviewsRating: 48,
          reviewsCount: 15934,
          price: {
            finalMoney: { amount: "4.55" },
            baseMoney: { amount: "9.09" },
          },
        },
      ],
    });
    expect(deal).toMatchObject({ price: 4.55, listPrice: 9.09 });
    expect(deal.details).toMatchObject({
      productRating: 4.8,
      productReviewCount: 15934,
      listPriceKind: "regular",
    });
  });
});

describe("parseNintendoSearch", () => {
  test("relative url and platform in the title", () => {
    const [deal] = parseNintendoSearch({
      response: {
        docs: [
          {
            fs_id: "1370376",
            title: "Street Fighter 6",
            url: "/fr-fr/Jeux/sf6.html",
            system_names_txt: ["Nintendo Switch 2"],
            price_discounted_f: 15.99,
            price_regular_f: 39.99,
          },
        ],
      },
    });
    expect(deal.url).toBe("https://www.nintendo.com/fr-fr/Jeux/sf6.html");
    expect(deal.title).toBe("Street Fighter 6 (Nintendo Switch 2, eShop)");
  });
});

describe("parsePlayStationGrid", () => {
  const product = (price: Record<string, unknown>) => ({
    data: {
      categoryGridRetrieve: {
        products: [
          {
            id: "EP1004-CUSA08519_00-REDEMPTIONFULL02",
            name: "Red Dead Redemption 2",
            platforms: ["PS4"],
            media: [{ role: "MASTER", type: "IMAGE", url: "https://img" }],
            price,
          },
        ],
      },
    },
  });

  test("a discounted game", () => {
    const [deal] = parsePlayStationGrid(
      product({
        basePrice: "€59,99",
        discountedPrice: "€14,99",
        discountText: "-75 %",
      }),
    );
    expect(deal).toMatchObject({ price: 14.99, listPrice: 59.99 });
  });

  test("a PS Plus-only price is skipped", () => {
    expect(
      parsePlayStationGrid(
        product({
          basePrice: "€59,99",
          discountedPrice: "€14,99",
          discountText: "-75 %",
          isTiedToSubscription: true,
        }),
      ),
    ).toEqual([]);
  });
});

describe("parseXboxDeals", () => {
  test("reads the embedded state", () => {
    const state = {
      core2: {
        products: {
          productSummaries: {
            "9NG07QJNK38J": {
              productId: "9NG07QJNK38J",
              title: "Among Us",
              averageRating: 4,
              ratingCount: 899,
              availableOn: ["XboxSeriesX", "PC"],
              specificPrices: {
                purchaseable: [{ listPrice: 2.99, msrp: 4.99 }],
              },
            },
          },
        },
      },
    };
    const html = `<script>window.__PRELOADED_STATE__ = ${JSON.stringify(state)};</script>`;
    const [deal] = parseXboxDeals(html);
    expect(deal).toMatchObject({ price: 2.99, listPrice: 4.99 });
    expect(deal.title).toBe("Among Us (Xbox Series, Xbox Store)");
  });
});

describe("parseLidlSearch", () => {
  const item = (discount: Record<string, unknown>) => ({
    items: [
      {
        gridbox: {
          data: {
            productId: 100412186,
            fullTitle: "PARKSIDE® Sécateur de jardin sans fil 4 V",
            canonicalUrl: "/p/parkside-secateur/p100412186",
            price: {
              price: 13.99,
              discount: { deletedPrice: 34.99, ...discount },
            },
            ratings: { average: 4.6, count: 863 },
          },
        },
      },
    ],
  });

  test("own regular price vs prix conseillé", () => {
    const [own] = parseLidlSearch(item({}), "diy");
    expect(own).toMatchObject({
      price: 13.99,
      listPrice: 34.99,
      categoryId: "diy",
      url: "https://www.lidl.fr/p/parkside-secateur/p100412186",
    });
    expect(own.details?.listPriceKind).toBe("regular");
    const [rrp] = parseLidlSearch(item({ fromRecommendedPrice: true }), "diy");
    expect(rrp.details?.listPriceKind).toBe("rrp");
  });

  test("a Lidl Plus-only price is skipped", () => {
    expect(
      parseLidlSearch(item({ fromNormalPriceForLidlPlus: true }), "diy"),
    ).toEqual([]);
  });
});

describe("parseIkeaOffers", () => {
  test("reads a product card", () => {
    const html = `<div data-product-number="20351011" data-price="15.99" data-currency="EUR" data-product-name="LATTJO" data-testid="plp-product-card">
      <a href="https://www.ikea.com/fr/fr/p/lattjo-housse-20351011/"><img src="https://www.ikea.com/img.jpg?f=xxs" alt=""></a>
      <span class="plp-price-module__description"><span>Housse de couette et 1 taie, 150x200 cm</span></span>
      <span class="plp-price__sr-text">Ancien prix 19,99€</span>
      <span class="plp-rating__sr-only">Révision: 4.7 hors de 5 étoiles.</span><span class="plp-price-module__rating-label-count">(139)</span>
    </div>`;
    const [deal] = parseIkeaOffers(html);
    expect(deal).toMatchObject({
      externalId: "20351011",
      price: 15.99,
      listPrice: 19.99,
      title: "IKEA LATTJO Housse de couette et 1 taie, 150x200 cm",
    });
    expect(deal.details).toMatchObject({
      productRating: 4.7,
      productReviewCount: 139,
    });
  });
});
