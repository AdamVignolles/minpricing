/**
 * Pure readers for the catalogue collection (`CatalogService`): a shop's
 * whole range rather than its sale page, read from what the shop publishes
 * for machines — its sitemap, each product page's schema.org `Product`
 * block, or a Shopify store's `products.json`. No shop-specific code: a
 * shop is an entry of `config/watch-sources.json`.
 */

/** What one product page (or feed row) says, nothing guessed. */
export interface CatalogProduct {
  /** Shop's own key when the reader has one (Shopify variant id). */
  externalId?: string;
  url?: string;
  title: string;
  brand?: string;
  /**
   * Maker's reference: the page's `mpn` (a shop's `sku` is usually its own
   * stock number — Ocarat's « 14495 » — so it is kept apart); on a brand's
   * own Shopify store, the variant's SKU.
   */
  reference?: string;
  sku?: string;
  ean?: string;
  price?: number;
  listPrice?: number;
  currency?: string;
  availability?: "in_stock" | "out_of_stock" | "unknown";
  imageUrl?: string;
  rating?: number;
  reviewCount?: number;
  description?: string;
}

const text = (value: unknown): string | undefined => {
  if (typeof value === "string") return value.trim() || undefined;
  if (typeof value === "number") return String(value);
  return undefined;
};

const number = (value: unknown): number | undefined => {
  if (typeof value === "number")
    return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string") return undefined;
  // « 1 299,00 », « 324.5 », « 1,299.00 »
  const cleaned = value.replace(/[^\d.,]/g, "");
  if (!cleaned) return undefined;
  const decimal = cleaned.match(/[.,](\d{1,2})$/);
  const whole = (decimal ? cleaned.slice(0, decimal.index) : cleaned).replace(
    /[.,]/g,
    "",
  );
  const parsed = Number(`${whole}${decimal ? `.${decimal[1]}` : ""}`);
  return Number.isFinite(parsed) ? parsed : undefined;
};

/** A GTIN-8/12/13/14 with a valid check digit, as 13 digits when it fits. */
export function cleanGtin(value: unknown): string | undefined {
  const digits = text(value)?.replace(/\D/g, "");
  if (!digits || ![8, 12, 13, 14].includes(digits.length)) return undefined;
  const sum = [...digits]
    .reverse()
    .reduce((acc, digit, i) => acc + Number(digit) * (i % 2 === 1 ? 3 : 1), 0);
  if (sum % 10 !== 0) return undefined;
  if (/^0+$/.test(digits)) return undefined;
  return digits.length === 12 ? `0${digits}` : digits;
}

function availabilityOf(value: unknown): CatalogProduct["availability"] {
  const raw = text(value)?.toLowerCase() ?? "";
  if (!raw) return "unknown";
  if (/instock|in_stock|limitedavailability|onlineonly/.test(raw)) {
    return "in_stock";
  }
  if (/outofstock|soldout|discontinued|out_of_stock/.test(raw)) {
    return "out_of_stock";
  }
  return "unknown";
}

const isType = (node: Record<string, unknown>, type: string) => {
  const value = node["@type"];
  return Array.isArray(value) ? value.includes(type) : value === type;
};

function findProducts(node: unknown, out: Record<string, unknown>[]): void {
  if (Array.isArray(node)) {
    for (const item of node) findProducts(item, out);
    return;
  }
  if (!node || typeof node !== "object") return;
  const record = node as Record<string, unknown>;
  if (isType(record, "Product")) {
    out.push(record);
    return;
  }
  for (const value of Object.values(record)) findProducts(value, out);
}

/**
 * The page's schema.org `Product` (JSON-LD), when it has exactly what a
 * product page has: one product with a name. A listing page carries
 * several — then nothing is returned, the page isn't a product page.
 * An `AggregateOffer` (several sellers or variants) gives no single
 * price: the product is kept without one rather than with its `lowPrice`.
 */
export function readJsonLdProduct(html: string): CatalogProduct | undefined {
  const products: Record<string, unknown>[] = [];
  const blocks = html.matchAll(
    /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  );
  for (const block of blocks) {
    try {
      findProducts(JSON.parse(block[1].trim()), products);
    } catch {
      // One malformed block must not hide the others.
    }
  }
  if (products.length !== 1) return undefined;
  const product = products[0];
  const title = text(product.name);
  if (!title) return undefined;

  const offersRaw = Array.isArray(product.offers)
    ? product.offers.length === 1
      ? product.offers[0]
      : undefined
    : product.offers;
  const offer =
    offersRaw && typeof offersRaw === "object"
      ? (offersRaw as Record<string, unknown>)
      : undefined;
  const single = offer && !isType(offer, "AggregateOffer") ? offer : undefined;

  const brandRaw = product.brand;
  const brand =
    brandRaw && typeof brandRaw === "object"
      ? text((brandRaw as Record<string, unknown>).name)
      : text(brandRaw);
  const imageRaw = Array.isArray(product.image)
    ? product.image[0]
    : product.image;
  const image =
    imageRaw && typeof imageRaw === "object"
      ? text((imageRaw as Record<string, unknown>).url)
      : text(imageRaw);
  const rating =
    product.aggregateRating && typeof product.aggregateRating === "object"
      ? (product.aggregateRating as Record<string, unknown>)
      : undefined;
  const sku = text(product.sku);
  const price = single ? number(single.price) : undefined;

  return {
    title,
    brand,
    sku,
    reference: text(product.mpn),
    ean:
      cleanGtin(product.gtin13) ??
      cleanGtin(product.gtin) ??
      cleanGtin(product.gtin14) ??
      cleanGtin(product.gtin12) ??
      cleanGtin(product.gtin8) ??
      (single
        ? (cleanGtin(single.gtin13) ?? cleanGtin(single.gtin))
        : undefined),
    price: price !== undefined && price > 0 ? price : undefined,
    currency: single ? text(single.priceCurrency) : undefined,
    availability: single ? availabilityOf(single.availability) : "unknown",
    imageUrl: image,
    rating: rating ? number(rating.ratingValue) : undefined,
    reviewCount: rating
      ? number(rating.reviewCount ?? rating.ratingCount)
      : undefined,
    description: text(product.description)?.slice(0, 2000),
    url: text(product.url) ?? (single ? text(single.url) : undefined),
  };
}

/** `<loc>` entries of a sitemap or sitemap index, and which of the two. */
export function readSitemap(xml: string): { index: boolean; urls: string[] } {
  const urls = [...xml.matchAll(/<loc>\s*(?:<!\[CDATA\[)?([^<\]]+)/gi)].map(
    (match) => match[1].trim().replace(/&amp;/g, "&"),
  );
  return { index: /<sitemapindex[\s>]/i.test(xml), urls };
}

/**
 * Does `robots.txt` let a generic crawler (`User-agent: *`) read this
 * path? Longest matching rule wins, `Allow` on a tie (the usual reading);
 * `*` and `$` are understood. No file or no `*` group: allowed.
 */
export function robotsAllows(robots: string, path: string): boolean {
  const rules: Array<{ allow: boolean; pattern: string }> = [];
  let inStar = false;
  let lastWasAgent = false;
  for (const raw of robots.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    const match = line.match(/^([a-z-]+)\s*:\s*(.*)$/i);
    if (!match) continue;
    const key = match[1].toLowerCase();
    const value = match[2].trim();
    if (key === "user-agent") {
      // Consecutive User-agent lines share the group that follows.
      inStar = lastWasAgent ? inStar || value === "*" : value === "*";
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!inStar || !value) continue;
    if (key === "allow" || key === "disallow") {
      rules.push({ allow: key === "allow", pattern: value });
    }
  }
  let best: { allow: boolean; length: number } | undefined;
  for (const rule of rules) {
    const anchored = rule.pattern.endsWith("$");
    const body = anchored ? rule.pattern.slice(0, -1) : rule.pattern;
    const regex = new RegExp(
      `^${body
        .split("*")
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join(".*")}${anchored ? "$" : ""}`,
    );
    if (!regex.test(path)) continue;
    const length = rule.pattern.length;
    if (
      !best ||
      length > best.length ||
      (length === best.length && rule.allow)
    ) {
      best = { allow: rule.allow, length };
    }
  }
  return best ? best.allow : true;
}

/**
 * A Shopify store's `/products.json` page: one row per variant (a
 * variant is a dial or strap, with its own SKU and price).
 * `compare_at_price` is the shop's struck price.
 */
export function readShopifyProducts(
  json: unknown,
  origin: string,
): CatalogProduct[] {
  const products = (json as { products?: unknown })?.products;
  if (!Array.isArray(products)) return [];
  return products.flatMap((raw) => {
    const product = raw as Record<string, unknown>;
    const title = text(product.title);
    const handle = text(product.handle);
    const variants = Array.isArray(product.variants) ? product.variants : [];
    if (!title || !handle) return [];
    const images = Array.isArray(product.images) ? product.images : [];
    const image = text((images[0] as Record<string, unknown>)?.src);
    return variants.flatMap((rawVariant) => {
      const variant = rawVariant as Record<string, unknown>;
      const id = text(variant.id);
      const price = number(variant.price);
      if (!id || price === undefined || price <= 0) return [];
      const variantTitle = text(variant.title);
      const struck = number(variant.compare_at_price);
      const sku = text(variant.sku);
      return [
        {
          externalId: id,
          url: `${origin}/products/${handle}${variants.length > 1 ? `?variant=${id}` : ""}`,
          title:
            variantTitle && variantTitle !== "Default Title"
              ? `${title} - ${variantTitle}`
              : title,
          brand: text(product.vendor),
          sku,
          reference: sku,
          ean: cleanGtin(variant.barcode),
          price,
          listPrice:
            struck !== undefined && struck > price ? struck : undefined,
          availability:
            variant.available === true
              ? ("in_stock" as const)
              : variant.available === false
                ? ("out_of_stock" as const)
                : ("unknown" as const),
          imageUrl: image,
        },
      ];
    });
  });
}
