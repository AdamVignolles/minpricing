import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { AliExpressCollector } from "../src/api/collectors/AliExpressCollector.ts";
import { AmazonCollector } from "../src/api/collectors/AmazonCollector.ts";
import { CdiscountCollector } from "../src/api/collectors/CdiscountCollector.ts";
import { SteamCollector } from "../src/api/collectors/SteamCollector.ts";

const fixture = (name: string) =>
  readFileSync(join(import.meta.dirname, "fixtures/links", name), "utf8");

/**
 * Pages served instead of the network: every browser context the
 * collectors open answers from these saved pages, anything else is 404.
 * The real Chromium runs the collectors' own selectors and parsers.
 */
const served = new Map<string, string>();
const visited: string[] = [];

vi.mock("playwright", async (importOriginal) => {
  const real = await importOriginal<typeof import("playwright")>();
  return {
    ...real,
    chromium: {
      launch: async (options?: object) => {
        const browser = await real.chromium.launch(options);
        const newContext = browser.newContext.bind(browser);
        browser.newContext = async (contextOptions) => {
          const context = await newContext(contextOptions);
          await context.route("**/*", (route) => {
            const url = route.request().url();
            visited.push(url);
            const body = served.get(url.split("?")[0]);
            return body
              ? route.fulfill({ status: 200, contentType: "text/html", body })
              : route.fulfill({ status: 404, body: "" });
          });
          return context;
        };
        return browser;
      },
    },
  };
});

afterEach(() => {
  served.clear();
  visited.length = 0;
  vi.unstubAllGlobals();
});

describe("collect(products) reads one product by id", () => {
  it("Amazon: product page by ASIN, same parser as collection", async () => {
    served.set(
      "https://www.amazon.fr/dp/B0DQVFFXN2",
      fixture("amazon-B0DQVFFXN2.html"),
    );
    const deals = await new AmazonCollector([]).collect([
      {
        id: "link-1",
        url: "https://www.amazon.fr/dp/B0DQVFFXN2",
        externalId: "B0DQVFFXN2",
      },
      // Not an ASIN: never opened.
      { id: "link-2", url: "https://example.com", externalId: "nope" },
    ]);
    expect(deals).toHaveLength(1);
    expect(deals[0]).toMatchObject({
      externalId: "B0DQVFFXN2",
      productId: "link-1",
      title: "Braun Series 3 3040s Rasoir Électrique Homme",
      url: "https://www.amazon.fr/dp/B0DQVFFXN2",
      price: 49.99,
      listPrice: 89.99,
      merchantId: "amazon",
      categoryHint: "amazon-crumb:Hygiène et Santé",
      details: {
        productRating: 4.5,
        productReviewCount: 12345,
        soldByMerchant: true,
        lowestRecentPrice: 59.99,
      },
    });
    expect(deals[0].imageUrl).toContain("71abc");
    expect(visited.some((url) => url.includes("example.com"))).toBe(false);
  }, 60_000);

  it("Cdiscount: product page price, title, seller and EAN", async () => {
    const url =
      "https://www.cdiscount.com/electromenager/petits-appareils-de-cuisson/friteuse-ninja/f-1102002-aaawc85840.html";
    served.set(url, fixture("cdiscount-product.html"));
    const deals = await new CdiscountCollector([]).collect([
      { id: "link-1", url, externalId: url },
    ]);
    expect(deals).toHaveLength(1);
    expect(deals[0]).toMatchObject({
      externalId: url,
      title: "Friteuse sans huile NINJA Foodi MAX Dual Zone AF400EU",
      price: 179.99,
      listPrice: 249.99,
      merchantId: "cdiscount",
      categoryHint: expect.stringContaining("electromenager"),
      imageUrl: expect.stringContaining("friteuse.jpg"),
      details: {
        ean: "5025232123456",
        productRating: 4.7,
        productReviewCount: 812,
        soldByMerchant: true,
        listPriceKind: "rrp",
      },
    });
  }, 60_000);

  it("AliExpress: item page by id", async () => {
    served.set(
      "https://fr.aliexpress.com/item/1005006123456789.html",
      fixture("aliexpress-item.html"),
    );
    const deals = await new AliExpressCollector([]).collect([
      {
        id: "link-1",
        url: "https://fr.aliexpress.com/item/1005006123456789.html",
        externalId: "1005006123456789",
      },
    ]);
    expect(deals).toHaveLength(1);
    expect(deals[0]).toMatchObject({
      externalId: "1005006123456789",
      title: "Xiaomi Redmi Buds 6 Active écouteurs Bluetooth 5.4",
      price: 12.99,
      listPrice: 29.99,
      merchantId: "aliexpress",
      imageUrl: "https://ae01.alicdn.com/kf/S123.jpg",
      details: {
        sellerName: "Xiaomi Official Store",
        productRating: 4.8,
        productReviewCount: 2345,
        shippedByMerchant: true,
      },
    });
  }, 60_000);

  it("a page that fails is skipped, not thrown", async () => {
    const deals = await new AmazonCollector([]).collect([
      {
        id: "link-1",
        url: "https://www.amazon.fr/dp/B000000000",
        externalId: "B000000000",
      },
    ]);
    expect(deals).toEqual([]);
  }, 60_000);

  it("Steam: appdetails by the link's appid, with the store's name and image", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) => {
        if (input.includes("/api/appdetails")) {
          return Response.json({
            "1145350": {
              success: true,
              data: {
                name: "Hades II",
                header_image: "https://cdn.steam/1145350/header.jpg",
                short_description: "Battle beyond the Underworld.",
                price_overview: {
                  currency: "EUR",
                  initial: 2950,
                  final: 2065,
                  discount_percent: 30,
                },
              },
            },
          });
        }
        return new Response("", { status: 404 });
      }),
    );
    const deals = await new SteamCollector().collect([
      {
        id: "link-1",
        url: "https://store.steampowered.com/app/1145350",
        externalId: "1145350",
      },
    ]);
    expect(deals).toHaveLength(1);
    expect(deals[0]).toMatchObject({
      externalId: "1145350",
      title: "Hades II",
      price: 20.65,
      listPrice: 29.5,
      imageUrl: "https://cdn.steam/1145350/header.jpg",
    });
  });
});
