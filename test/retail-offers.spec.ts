import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test, vi } from "vitest";

import { parseCarrefourPrices } from "../src/api/collectors/CarrefourCollector.ts";
import {
  leclercFeaturedEans,
  parseCastoramaTiles,
  parseFootLockerCards,
  parseGrosbillCards,
  parseItJustGoodCards,
  parseLeclercProducts,
  parseNikeWall,
  parseScrewfixListing,
} from "../src/api/collectors/retailOffers.ts";
import { LeclercCollector } from "../src/api/collectors/StoreCollectors.ts";

describe("Leclerc", () => {
  const offer = (shop: string, base: number, now?: number) => ({
    basePrice: {
      price: { price: base },
      discountPrice: now ? { price: { price: now } } : null,
    },
    shop: { id: shop, label: shop === "Leclerc" ? "E.Leclerc" : shop },
    stock: 10,
  });
  const product = (offers: unknown[]) => [
    {
      label: "Samsung Galaxy A37 5G 128 Go Graphite",
      variants: [
        {
          sku: "8806099035273",
          slug: "samsung-galaxy-a37",
          offers,
          attributes: [{ code: "image1", value: { url: "https://img/1" } }],
        },
      ],
    },
  ];

  test("featured EANs come from the universe JSON", () => {
    expect(
      leclercFeaturedEans('{"link":"/fp/tv-5901292528577","x":5901292528577}'),
    ).toEqual(["5901292528577"]);
  });

  test("Leclerc's own discount wins over a marketplace's struck price", () => {
    const [deal] = parseLeclercProducts(
      product([offer("Leclerc", 44900, 37900), offer("2005", 31110, 28999)]),
      "phones",
    );
    expect(deal).toMatchObject({
      price: 379,
      listPrice: 449,
      url: "https://www.e.leclerc/fp/samsung-galaxy-a37-8806099035273",
    });
    expect(deal.details).toMatchObject({
      soldByMerchant: true,
      bestOtherOfferPrice: 289.99,
      ean: "8806099035273",
    });
  });

  test("no discount anywhere: nothing", () => {
    expect(parseLeclercProducts(product([offer("Leclerc", 44900)]))).toEqual(
      [],
    );
  });
});

describe("Leclerc collect() by EAN", () => {
  test("reads the products asked for, through the same product API", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify([
          {
            label: "Pokemon Battle Disc Showdown Game Pikachu & Larvitar",
            variants: [
              {
                sku: "0191726947813",
                slug: "pokemon-battle-disc",
                offers: [
                  {
                    basePrice: {
                      price: { price: 3999 },
                      discountPrice: { price: { price: 3240 } },
                    },
                    shop: { id: "Leclerc", label: "E.Leclerc" },
                    stock: 5,
                  },
                ],
              },
            ],
          },
        ]),
      ),
    );
    const deals = await new LeclercCollector().collect([
      {
        id: "d1",
        url: "https://www.e.leclerc/fp/x",
        externalId: "0191726947813",
      },
      { id: "d2", url: "https://www.e.leclerc/fp/y", externalId: "not-an-ean" },
    ]);
    expect(deals).toHaveLength(1);
    expect(deals[0]).toMatchObject({
      externalId: "0191726947813",
      price: 32.4,
      listPrice: 39.99,
    });
    expect(String(fetchSpy.mock.calls[0][0])).toContain("skus=0191726947813");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    fetchSpy.mockRestore();
  });
});

describe("Grosbill", () => {
  test("reads a promo card", () => {
    const html = `<article class="card" data-gsl-pid="146543"><img src="/media/m/a.webp" alt="">
      <a class="card-name" href="/kingston-snv3s-1to-146543">T&#039;nB Kingston SNV3S 1To</a>
      <div class="card-price" data-price="159.99"><span class="price">159,99 €</span>
      <span class="price-old">194,99 €</span></div><span class="card-stock in">En stock</span></article>`;
    const [deal] = parseGrosbillCards(html);
    expect(deal).toMatchObject({
      externalId: "146543",
      title: "T'nB Kingston SNV3S 1To",
      price: 159.99,
      listPrice: 194.99,
      url: "https://www.grosbill.com/kingston-snv3s-1to-146543",
    });
  });
});

describe("Grosbill (2026-11 markup)", () => {
  test("cents in a nested tag are kept: data-price first", () => {
    const html = `<article class="card" data-gsl-pid="146600"><img src="/media/m/b.webp" alt="">
      <a class="card-name" href="/kingston-snv3s-1to-146600">Kingston SNV3S 1To M.2</a>
      <div class="card-price" data-price="169.99"> <span class="price">169<span class="price-dec"><span class="price-sep">,</span>99</span><span class="price-cur"> €</span></span>
      <span class="price-old">209,99 €</span> <span class="card-discount">−40 €</span> </div><span class="card-stock in">En stock</span></article>`;
    expect(parseGrosbillCards(html)[0]).toMatchObject({
      price: 169.99,
      listPrice: 209.99,
    });
    expect(
      parseGrosbillCards(html.replace(' data-price="169.99"', ""))[0]?.price,
    ).toBe(169.99);
  });
});

describe("Nike", () => {
  test("one deal per model, brand not doubled", () => {
    const [deal] = parseNikeWall({
      productGroupings: [
        {
          products: [
            {
              productCode: "HQ6918-320",
              productType: "FOOTWEAR",
              copy: { title: "Nike Air Superfly", subTitle: "Chaussure" },
              prices: { currentPrice: 69.99, initialPrice: 99.99 },
              pdpUrl: { url: "https://www.nike.com/fr/t/x" },
            },
          ],
        },
      ],
    });
    expect(deal.title).toBe("Nike Air Superfly - Chaussure");
    expect(deal).toMatchObject({ price: 69.99, listPrice: 99.99 });
  });
});

describe("Foot Locker", () => {
  test("reads the sale card", () => {
    const html = `<div data-testid="ProductCardV3"><a data-productcard="{&quot;name&quot;:&quot;New Balance 740 - Femme Chaussures&quot;,&quot;sku&quot;:&quot;315216188102&quot;}" href="/fr/product/nb-740/315216188102.html">
      <span>Cet article est en promotion. Prix en baisse de € 129,99 à € 115,00</span></a>
      <img src="https://images.footlocker.com/x?wid=250&amp;hei=250"/></div>`;
    const [deal] = parseFootLockerCards(html);
    expect(deal).toMatchObject({
      externalId: "315216188102",
      title: "New Balance 740 - Femme Chaussures",
      price: 115,
      listPrice: 129.99,
    });
  });
});

describe("Castorama", () => {
  test("reads a tile, EAN is not a review count", () => {
    const html = `<div data-testid="product" data-ean="3465700054826"><a href="/radiateur/3465700054826_CAFR.prd">
      <img src="https://media.castorama.fr/x?$width=96&amp;$height=96"/></a>
      <p data-testid="product-name">Radiateur électrique connecté 1000W</p>
      <span>( 21 )</span> Prix d’origine 459,90 € 459,90 € <span>409</span> , <span>90</span> €</div>`;
    const [deal] = parseCastoramaTiles(html);
    expect(deal).toMatchObject({
      externalId: "3465700054826",
      price: 409.9,
      listPrice: 459.9,
    });
    expect(deal.details?.productReviewCount).toBe(21);
  });
});

describe("Carrefour", () => {
  test("price 'au lieu de' struck price", () => {
    expect(
      parseCarrefourPrices("MOULINEX 199 ,99 € au lieu de 299,99 € Dont 0.72€"),
    ).toEqual({ price: 199.99, listPrice: 299.99 });
    expect(
      parseCarrefourPrices("ASUS 1 029 ,99 € au lieu de 1 199,99 €"),
    ).toEqual({ price: 1029.99, listPrice: 1199.99 });
    expect(parseCarrefourPrices("1,89 € / U")).toBe(undefined);
  });
});

describe("ITJustGood", () => {
  test("refurbished card: new-equivalent price is only a prix conseillé", () => {
    const html = `<li class="item product product-item"> <a href="x"><picture>
      <img data-webpconverted="1" src="https://www.itjustgood.com/static/Magefan_LazyLoad/images/pixel.jpg" data-original="https://www.itjustgood.com/media/latitude.jpg" class="product-image-photo" alt=""/></picture></a>
      <span class="text" style="color: #ffffff"> Très bon état </span>
      <a class="product-item-link" href="https://www.itjustgood.com/dell-latitude-5410.html"> Dell Latitude 5410 - 14&quot; Full HD </a>
      <div class="attributes-concatenation"> Intel Core i5-10310U - 16 Go RAM - 256 Go SSD </div>
      <div class="price-box" data-product-id="28001">
      <span id="product-price-28001" data-price-amount="359.896001" data-price-type="finalPrice"></span>
      <span id="old-price-28001" data-price-amount="779.904001" data-price-type="oldPrice"></span></div></li>`;
    const [deal] = parseItJustGoodCards(html);
    expect(deal).toMatchObject({
      externalId: "28001",
      price: 359.9,
      listPrice: 779.9,
      imageUrl: "https://www.itjustgood.com/media/latitude.jpg",
      title:
        'PC portable reconditionné Dell Latitude 5410 - 14" Full HD - Intel Core i5-10310U - 16 Go RAM - 256 Go SSD',
    });
    expect(deal.details).toMatchObject({
      condition: "refurbished",
      listPriceKind: "rrp",
    });
    expect(deal.description).toContain("- État : Très bon état");
  });
});

describe("parseScrewfixListing (saved 2026-11 déstockage page)", () => {
  const html = readFileSync(
    join(import.meta.dirname, "fixtures/screwfix/destockage.html"),
    "utf8",
  );

  test("reads the cards: code, TTC price, « AU LIEU DE » as the 30-day reference", () => {
    const deals = parseScrewfixListing(html);
    expect(deals).toHaveLength(46);
    expect(deals.filter((deal) => deal.listPrice)).toHaveLength(44);
    expect(deals[0]).toMatchObject({
      externalId: "603TR",
      title:
        "Perceuse visseuse à percussion sans fil brushless DEWALT DCD706D2-QW Li-Ion XR 12V 2 x 2Ah",
      url: "https://www.screwfix.fr/perceuse-visseuse-a-percussion-sans-fil-brushless-dewalt-dcd706d2-qw-li-ion-xr-12v-2-x-2ah.html",
      imageUrl:
        "https://media.screwfix.fr/is/image/ae235?src=ae235/603TR_P&$prodImageMedium$",
      price: 169.99,
      listPrice: 199.99,
      merchantId: "screwfix",
      details: {
        soldByMerchant: true,
        listPriceKind: "regular",
        lowestRecentPrice: 199.99,
      },
    });
  });

  test("a card without a struck price has no reference", () => {
    const deal = parseScrewfixListing(html).find(
      (item) => item.externalId === "115CH",
    );
    expect(deal).toMatchObject({ price: 59.99, listPrice: undefined });
    expect(deal?.details?.listPriceKind).toBeUndefined();
  });

  test("a card that can't be bought online is skipped", () => {
    const card = (button: string) =>
      `<li class="item product product-item"><a class="product-item-link" href="https://www.screwfix.fr/x.html">Scie</a><span class="product-sku"> (Code: 123AB)</span><span data-label="TTC" data-price-amount="9.99" data-price-type="finalPrice"></span>${button}</li>`;
    expect(
      parseScrewfixListing(card('<button class="action tocart primary">')),
    ).toHaveLength(1);
    expect(parseScrewfixListing(card(""))).toHaveLength(0);
  });
});
