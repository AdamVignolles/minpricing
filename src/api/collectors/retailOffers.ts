import { parsePcSpecs } from "../services/pcSpecs.ts";
import type { RawDeal } from "./DealSource.ts";
import { parseEuro } from "./storeOffers.ts";

/**
 * Pure parsers for the retailers read with plain `fetch`: Leclerc's own
 * JSON API and the server-rendered promo pages of Grosbill, Foot Locker
 * and Castorama, plus Nike's product-wall API. Same rules as
 * `storeOffers.ts`: the struck price is the retailer's own previous price
 * (French law on price reductions), hence `listPriceKind: "regular"`.
 */

const SELF_SOLD = {
  soldByMerchant: true,
  shippedByMerchant: true,
  condition: "new" as const,
};

function decodeHtml(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#0?39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ------------------------------------------------------------- Leclerc

interface LeclercOffer {
  basePrice?: {
    price?: { price?: number };
    discountPrice?: { price?: { price?: number } } | null;
  };
  shop?: { id?: string; label?: string };
  stock?: number;
}

interface LeclercProduct {
  label?: string;
  sku?: string;
  slug?: string;
  variants?: Array<{
    sku?: string;
    slug?: string;
    offers?: LeclercOffer[];
    attributes?: Array<{ code: string; value?: unknown }>;
  }>;
}

/** Every EAN-13 a Leclerc universe page features (its own CMS JSON). */
export function leclercFeaturedEans(categoryJson: string): string[] {
  return [...new Set(categoryJson.match(/\b\d{13}\b/g) ?? [])];
}

/**
 * Leclerc's `products-details-by-skus` answer: the offer's "basePrice" vs
 * its "discountPrice", cheapest offer in stock first — E.Leclerc itself or
 * a marketplace shop, which the seller fields then say.
 */
export function parseLeclercProducts(
  json: unknown,
  categoryId?: string,
): RawDeal[] {
  const products = (Array.isArray(json) ? json : []) as LeclercProduct[];
  return products.flatMap((product) => {
    const variant = product.variants?.[0];
    const ean = variant?.sku ?? product.sku;
    if (!product.label || !ean || !variant?.offers?.length) return [];
    const offers = variant.offers
      .filter((offer) => (offer.stock ?? 1) > 0)
      .map((offer) => {
        const base = offer.basePrice?.price?.price ?? 0;
        const discounted = offer.basePrice?.discountPrice?.price?.price;
        return { offer, base, now: discounted ?? base };
      })
      .filter((o) => o.base > 0);
    const discounted = offers
      .filter((o) => o.now < o.base)
      .sort((a, b) => a.now - b.now);
    // E.Leclerc's own discount first: a marketplace shop's "base price" is
    // whatever that shop typed, not a price anyone paid.
    const best =
      discounted.find((o) => o.offer.shop?.id === "Leclerc") ?? discounted[0];
    if (!best) return [];
    const ownShop = best.offer.shop?.id === "Leclerc";
    const others = offers.filter((o) => o !== best).map((o) => o.now);
    const image = variant.attributes?.find((a) => a.code === "image1")
      ?.value as { url?: string } | undefined;
    const slug = variant.slug ?? product.slug;
    return [
      {
        externalId: ean,
        title: product.label,
        url: `https://www.e.leclerc/fp/${slug ? `${slug}-` : ""}${ean}`,
        imageUrl: image?.url,
        price: best.now / 100,
        listPrice: best.base / 100,
        currency: "EUR",
        availability: "in_stock" as const,
        categoryId,
        merchantId: "leclerc",
        details: {
          ean,
          sellerName: best.offer.shop?.label ?? "E.Leclerc",
          soldByMerchant: ownShop,
          shippedByMerchant: ownShop,
          condition: "new" as const,
          listPriceKind: "regular" as const,
          offersCount: offers.length,
          bestOtherOfferPrice: others.length
            ? Math.min(...others) / 100
            : undefined,
        },
      },
    ];
  });
}

// ------------------------------------------------------------ Grosbill

/** Grosbill promo pages (server-rendered `article.card`). */
export function parseGrosbillCards(html: string): RawDeal[] {
  return html
    .split('<article class="card"')
    .slice(1)
    .flatMap((card) => {
      const id = card.match(/data-gsl-pid="(\d+)"/)?.[1];
      const link = card.match(/class="card-name" href="([^"]+)">([^<]+)</);
      const price = parseEuro(card.match(/class="price">([^<]+)</)?.[1]);
      const list = parseEuro(card.match(/class="price-old">([^<]+)</)?.[1]);
      if (!id || !link || !price || !list || price >= list) return [];
      if (/card-stock out/.test(card)) return [];
      const image = card.match(/<img src="([^"]+)"/)?.[1];
      return [
        {
          externalId: id,
          title: decodeHtml(link[2]),
          url: `https://www.grosbill.com${link[1]}`,
          imageUrl: image ? `https://www.grosbill.com${image}` : undefined,
          price,
          listPrice: list,
          currency: "EUR",
          availability: "in_stock" as const,
          merchantId: "grosbill",
          details: {
            ...SELF_SOLD,
            sellerName: "Grosbill",
            listPriceKind: "regular" as const,
          },
        },
      ];
    });
}

// ---------------------------------------------------------------- Nike

interface NikeProduct {
  productCode?: string;
  productType?: string;
  copy?: { title?: string; subTitle?: string };
  displayColors?: { colorDescription?: string };
  prices?: { currentPrice?: number; initialPrice?: number };
  colorwayImages?: { squarishURL?: string; portraitURL?: string };
  pdpUrl?: { url?: string };
}

/** Nike's product wall API (`api.nike.com/discover/product_wall`). */
export function parseNikeWall(json: unknown): RawDeal[] {
  const groups =
    (json as { productGroupings?: Array<{ products?: NikeProduct[] }> })
      .productGroupings ?? [];
  return groups.flatMap((group) => {
    // One card per model: the first colourway stands for the group.
    const p = group.products?.[0];
    const price = p?.prices?.currentPrice;
    const list = p?.prices?.initialPrice;
    if (!p?.productCode || !p.copy?.title || !p.pdpUrl?.url) return [];
    if (!price || !list || price >= list) return [];
    return [
      {
        externalId: p.productCode,
        title: `${/^nike\b/i.test(p.copy.title) ? p.copy.title : `Nike ${p.copy.title}`}${p.copy.subTitle ? ` - ${p.copy.subTitle}` : ""}`,
        url: p.pdpUrl.url,
        imageUrl:
          p.colorwayImages?.squarishURL ?? p.colorwayImages?.portraitURL,
        price,
        listPrice: list,
        currency: "EUR",
        availability: "in_stock" as const,
        categoryId: p.productType === "FOOTWEAR" ? "fashion" : "sport",
        merchantId: "nike",
        description: p.displayColors?.colorDescription
          ? `Coloris : ${p.displayColors.colorDescription}.`
          : undefined,
        details: {
          ...SELF_SOLD,
          sellerName: "Nike",
          listPriceKind: "regular" as const,
        },
      },
    ];
  });
}

// ---------------------------------------------------------- Foot Locker

/** Foot Locker sale pages (server-rendered `ProductCardV3`). */
export function parseFootLockerCards(html: string): RawDeal[] {
  return html
    .split('data-testid="ProductCardV3"')
    .slice(1)
    .flatMap((card) => {
      const data = card.match(/data-productcard="([^"]+)"/)?.[1];
      const href = card.match(/href="(\/fr\/product\/[^"]+)"/)?.[1];
      const prices = card.match(
        /Prix en baisse de €\s?([\d\s.,]+?) à €\s?([\d\s.,]+?)</,
      );
      if (!data || !href || !prices) return [];
      let meta: { name?: string; sku?: string };
      try {
        meta = JSON.parse(data.replace(/&quot;/g, '"').replace(/&amp;/g, "&"));
      } catch {
        return [];
      }
      const list = parseEuro(prices[1]);
      const price = parseEuro(prices[2]);
      if (!meta.name || !meta.sku || !price || !list || price >= list) {
        return [];
      }
      return [
        {
          externalId: meta.sku,
          title: meta.name,
          url: `https://www.footlocker.fr${href}`,
          imageUrl: card
            .match(/<img[^>]*src="([^"]+)"/)?.[1]
            ?.replace(/&amp;/g, "&"),
          price,
          listPrice: list,
          currency: "EUR",
          availability: "in_stock" as const,
          categoryId: "fashion",
          merchantId: "footlocker",
          details: {
            ...SELF_SOLD,
            sellerName: "Foot Locker",
            listPriceKind: "regular" as const,
          },
        },
      ];
    });
}

// ------------------------------------------------------------ Castorama

const CASTO_PRICES =
  /Prix d[’']origine\s*([\d\s]+,\d{2})\s*€\s*[\d\s]+,\d{2}\s*€\s*([\d\s]+?)\s*,\s*(\d{2})\s*€/;

/** Castorama offer pages (server-rendered product tiles, EAN on each). */
export function parseCastoramaTiles(html: string): RawDeal[] {
  return html
    .split('data-testid="product" data-ean="')
    .slice(1)
    .flatMap((tile) => {
      const ean = tile.match(/^(\d{8,14})"/)?.[1];
      const href = tile.match(/href="([^"]+\.prd)"/)?.[1];
      const name = tile.match(/data-testid="product-name"[^>]*>([^<]+)</)?.[1];
      const text = decodeHtml(tile.replace(/<[^>]+>/g, " "));
      const prices = text.match(CASTO_PRICES);
      if (!ean || !href || !name || !prices) return [];
      const list = parseEuro(prices[1]);
      const price = parseEuro(`${prices[2]},${prices[3]}`);
      if (!price || !list || price >= list) return [];
      const reviews = text.match(/\(\s*(\d{1,6})\s*\)/)?.[1];
      return [
        {
          externalId: ean,
          title: decodeHtml(name),
          url: `https://www.castorama.fr${href}`,
          imageUrl: tile
            .match(/<img[^>]*src="([^"]+)"/)?.[1]
            ?.replace(/&amp;/g, "&")
            .replace("$width=96&$height=96", "$width=568&$height=568"),
          price,
          listPrice: list,
          currency: "EUR",
          availability: "in_stock" as const,
          categoryId: "diy",
          merchantId: "castorama",
          details: {
            ...SELF_SOLD,
            ean,
            sellerName: "Castorama",
            listPriceKind: "regular" as const,
            productReviewCount: reviews ? Number(reviews) : undefined,
          },
        },
      ];
    });
}

// ---------------------------------------------------------------- Lenovo

interface LenovoProduct {
  productCode?: string;
  productName?: string;
  finalPrice?: string;
  webPrice?: string;
  couponCode?: string;
  ratingStar?: string;
  commentCount?: number;
  url?: string;
  leadTimeMessage?: string;
  isOutlet?: boolean;
  media?: { gallery?: Array<{ imageAddress?: string }> };
  classification?: Array<{ a?: string; b?: string }>;
}

/** "IdeaPad Slim 3 16IWC11_83RS - IdeaPad Slim 3 16IWC11_01_FR" → "IdeaPad Slim 3 16IWC11". */
export function lenovoModelName(productName: string): string {
  return productName
    .split(" - ")[0]
    .replace(/_[A-Z0-9]{3,5}$/, "")
    .trim();
}

/**
 * ".../yoga-slim-series/yoga-slim-7-gen-9-15-inch-intel/83cl..." →
 * "Yoga Slim 7 Gen 9 15 Intel".
 */
export function lenovoModelFromUrl(url: string): string {
  const parts = url.split("/").filter(Boolean);
  const slug = parts[parts.length - 2] ?? parts[parts.length - 1] ?? "";
  return slug
    .replace(/^lenovo-/, "")
    .replace(/-inch\b/g, "")
    .split("-")
    .filter(Boolean)
    .map((w) => (/^\d/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ");
}

const LENOVO_CPU: Array<[RegExp, string]> = [
  [/\bU([579])\b/, "Core Ultra $1"],
  [/\bCORE([357])\b/, "Core $1"],
  [/\bI([3579])\b/, "Core i$1"],
  [/\bR([3579])\b/, "Ryzen $1"],
];

/** "NB IPS3 15IRU10 CORE3 8G 8G 256G 11H" → processor, memory, storage lines. */
export function lenovoNameSpecs(productName: string): string[] {
  const name = productName.toUpperCase();
  const lines: string[] = [];
  for (const [pattern, label] of LENOVO_CPU) {
    const match = name.match(pattern);
    if (match) {
      lines.push(`- Processeur : ${label.replace("$1", match[1])}`);
      break;
    }
  }
  const sizes = [...name.matchAll(/\b(\d{1,4})(G|T)\b/g)].map((m) =>
    m[2] === "T" ? Number(m[1]) * 1000 : Number(m[1]),
  );
  const ram = sizes.find((gb) => gb <= 64);
  const storage = sizes.find((gb) => gb >= 128);
  if (ram) lines.push(`- Mémoire : ${ram} Go RAM`);
  if (storage) lines.push(`- Stockage : ${storage} Go SSD`);
  return lines;
}

/** Lenovo's own store API (laptops on sale), with its spec sheet. */
export function parseLenovoProducts(json: unknown): RawDeal[] {
  const products =
    (json as { data?: { data?: LenovoProduct[] } }).data?.data ?? [];
  return products.flatMap((p) => {
    const price = Number(p.finalPrice);
    const list = Number(p.webPrice);
    if (!p.productCode || !p.productName || !p.url) return [];
    if (!(price > 0) || !(list > price)) return [];
    const specs = (p.classification ?? [])
      .filter((spec) =>
        /processeur|mémoire|stockage|disque|écran|carte graphique|système/i.test(
          spec.a ?? "",
        ),
      )
      .map((spec) => `- ${spec.a} : ${decodeHtml(spec.b ?? "")}`);
    const image = p.media?.gallery?.[0]?.imageAddress;
    const rating = Number(p.ratingStar);
    // "NB YG Slim 7 15ILL9 U7 32G…" is an internal code: the product
    // page's address names the model properly.
    const model = /^(NB|NBLN|Pack)\b/.test(p.productName)
      ? lenovoModelFromUrl(p.url)
      : lenovoModelName(p.productName);
    // Pre-configured "NB …" models list no specs: their name encodes them.
    if (specs.length === 0) specs.push(...lenovoNameSpecs(p.productName));
    const spec = parsePcSpecs(specs.join("\n"));
    const summary = [
      spec.cpu,
      spec.ramGb ? `${spec.ramGb} Go RAM` : "",
      spec.storageGb
        ? spec.storageGb >= 1000
          ? `${spec.storageGb / 1000} To SSD`
          : `${spec.storageGb} Go SSD`
        : "",
    ]
      .filter(Boolean)
      .join(", ");
    return [
      {
        externalId: p.productCode,
        title: `PC portable Lenovo ${model}${summary ? ` - ${summary}` : ""}`,
        url: `https://www.lenovo.com/fr/fr${p.url}`,
        imageUrl: image ? `https:${image}` : undefined,
        price,
        listPrice: list,
        currency: "EUR",
        availability: "in_stock" as const,
        categoryId: "computing",
        merchantId: "lenovo",
        description: [
          ...specs,
          p.couponCode ? `- Prix avec le code ${p.couponCode}` : "",
          p.leadTimeMessage ? `- ${p.leadTimeMessage}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
        details: {
          ...SELF_SOLD,
          sellerName: "Lenovo",
          condition: p.isOutlet ? ("refurbished" as const) : ("new" as const),
          listPriceKind: "regular" as const,
          productRating: rating > 0 ? rating : undefined,
          productReviewCount: p.commentCount || undefined,
        },
      },
    ];
  });
}

// ---------------------------------------------------------- ITJustGood

/**
 * The card's product photo: lazy-loaded cards keep a 1-pixel placeholder
 * in `src` and the real image in `data-original`.
 */
function itJustGoodImage(card: string): string | undefined {
  const tag = card.match(/<img[^>]*class="product-image-photo"[^>]*>/)?.[0];
  if (!tag) return undefined;
  const original = tag.match(/data-original="([^"]+)"/)?.[1];
  const src = tag.match(/\ssrc="([^"]+)"/)?.[1];
  return original ?? (src && !/pixel\.jpg/.test(src) ? src : undefined);
}

/**
 * ITJustGood's promotions page (Magento, server-rendered): refurbished
 * business laptops. Its struck price is "Neuf équivalent" — what a *new*
 * equivalent machine costs, not a price ITJustGood charged — so it is a
 * "prix conseillé" (`rrp`), never a real former price.
 */
export function parseItJustGoodCards(html: string): RawDeal[] {
  return html
    .split('<li class="item product product-item')
    .slice(1)
    .flatMap((card) => {
      const id = card.match(/data-product-id="(\d+)"/)?.[1];
      const link = card.match(
        /class="product-item-link"\s+href="([^"]+)">([^<]+)</,
      );
      const price = Number(
        card
          .match(
            /data-price-type="finalPrice"[^>]*data-price-amount="([\d.]+)"|data-price-amount="([\d.]+)"\s+data-price-type="finalPrice"/,
          )
          ?.slice(1)
          .find(Boolean),
      );
      const list = Number(
        card.match(
          /data-price-amount="([\d.]+)"\s+data-price-type="oldPrice"/,
        )?.[1],
      );
      if (!id || !link || !(price > 0) || !(list > price)) return [];
      const specs = decodeHtml(
        card.match(/class="attributes-concatenation">([^<]*)</)?.[1] ?? "",
      );
      const name = decodeHtml(link[2]);
      const condition = card
        .match(
          /<span class="text"[^>]*>\s*([^<]*état[^<]*|Comme neuf|Parfait état)\s*</i,
        )?.[1]
        ?.trim();
      return [
        {
          externalId: id,
          title: `PC portable reconditionné ${name}${specs ? ` - ${specs}` : ""}`,
          url: link[1],
          imageUrl: itJustGoodImage(card),
          price: Math.round(price * 100) / 100,
          listPrice: Math.round(list * 100) / 100,
          currency: "EUR",
          availability: "in_stock" as const,
          categoryId: "computing",
          merchantId: "itjustgood",
          description: [
            specs ? `- Configuration : ${specs}` : "",
            condition ? `- État : ${condition}` : "",
            "- Reconditionné en France par ITJustGood",
          ]
            .filter(Boolean)
            .join("\n"),
          details: {
            sellerName: "ITJustGood",
            soldByMerchant: true,
            shippedByMerchant: true,
            condition: "refurbished" as const,
            listPriceKind: "rrp" as const,
          },
        },
      ];
    });
}
