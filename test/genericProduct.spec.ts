import { describe, expect, it } from "vitest";

import { parseProductHtml } from "../src/api/collectors/genericProduct.ts";

const page = (ld: unknown, head = "") =>
  `<html><head>${head}<script type="application/ld+json">${JSON.stringify(ld)}</script></head></html>`;

describe("parseProductHtml", () => {
  it("reads a JSON-LD Product with an offer", () => {
    const parsed = parseProductHtml(
      page({
        "@context": "https://schema.org",
        "@type": "Product",
        name: "Aspirateur X1",
        brand: { "@type": "Brand", name: "Acme" },
        image: ["https://img/x.jpg"],
        gtin13: "3700000000001",
        aggregateRating: { ratingValue: "4.4", reviewCount: "230" },
        offers: {
          "@type": "Offer",
          price: "129,90",
          priceCurrency: "EUR",
          availability: "https://schema.org/InStock",
          seller: { "@type": "Organization", name: "Shop" },
        },
      }),
    );
    expect(parsed).toMatchObject({
      title: "Acme Aspirateur X1",
      price: 129.9,
      currency: "EUR",
      availability: "in_stock",
      imageUrl: "https://img/x.jpg",
    });
    expect(parsed?.details).toMatchObject({
      productRating: 4.4,
      productReviewCount: 230,
      ean: "3700000000001",
      sellerName: "Shop",
    });
  });

  it("finds the product inside @graph and takes the cheapest offer", () => {
    const parsed = parseProductHtml(
      page({
        "@graph": [
          { "@type": "WebSite" },
          {
            "@type": "Product",
            name: "Casque",
            offers: [
              { "@type": "Offer", price: 80, priceCurrency: "EUR" },
              { "@type": "Offer", price: 59.5, priceCurrency: "EUR" },
            ],
          },
        ],
      }),
    );
    expect(parsed?.price).toBe(59.5);
  });

  it("falls back to OpenGraph price tags", () => {
    const parsed = parseProductHtml(
      `<head><meta property="og:title" content="Chaise"><meta property="product:price:amount" content="45.00"><meta property="product:price:currency" content="EUR"></head>`,
    );
    expect(parsed).toMatchObject({ title: "Chaise", price: 45 });
  });

  it("returns undefined without a price", () => {
    expect(
      parseProductHtml(page({ "@type": "Product", name: "Sans prix" })),
    ).toBeUndefined();
    expect(parseProductHtml("<html></html>")).toBeUndefined();
  });
});
