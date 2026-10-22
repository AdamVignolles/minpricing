import { describe, expect, test } from "vitest";

import { parseCarrefourPrices } from "../src/api/collectors/CarrefourCollector.ts";
import {
  leclercFeaturedEans,
  parseCastoramaTiles,
  parseFootLockerCards,
  parseGrosbillCards,
  parseItJustGoodCards,
  parseLeclercProducts,
  parseNikeWall,
} from "../src/api/collectors/retailOffers.ts";

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
