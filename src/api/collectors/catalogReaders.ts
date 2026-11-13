/**
 * Pure readers for the catalogue collection (`CatalogService`): a shop's
 * whole range rather than its sale page, read from what the shop publishes
 * for machines — its sitemap, each product page's schema.org `Product`
 * block, or a Shopify store's `products.json`. No shop-specific code: a
 * shop is an entry of `config/watch-sources.json`.
 */

import { load } from "cheerio";

/** One line of a product's characteristics, as the shop writes it. */
export interface CatalogSpec {
  label: string;
  value: string;
}

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
  /** The page's characteristics table (watch labels only). */
  specs?: CatalogSpec[];
  /** The offer's `itemCondition`, when stated. */
  condition?: "new" | "used" | "refurbished";
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
    condition: (() => {
      const raw = (
        text(single?.itemCondition) ??
        text(product.itemCondition) ??
        ""
      ).toLowerCase();
      if (/used|damaged/.test(raw)) return "used" as const;
      if (/refurbished/.test(raw)) return "refurbished" as const;
      if (/new/.test(raw)) return "new" as const;
      return undefined;
    })(),
    specs: (() => {
      const specs = propertySpecs(product.additionalProperty);
      return specs.length ? specs : undefined;
    })(),
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

// ------------------------------------------------------ characteristics

const foldLabel = (value: string) =>
  value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\(s\)/g, "")
    // « Diamètre (en mm) », « Étanchéité (en ATM) », « Calibres (mouvements) »
    .replace(/\s*\([^)]*\)/g, "")
    .replace(/\s*:\s*$/, "")
    .replace(/\s+/g, " ")
    .trim();

/**
 * Labels a watch's characteristics table uses (folded: lower case, no
 * accents). Anything else on the page — menus, delivery, reviews — is
 * left out, so a stray « Genre » menu title never becomes a spec.
 */
const WATCH_LABEL =
  /^(?=.{2,40}$)(?:[a-z' ]*\b)?(genre|sexe|mouvements?|mecanisme|calibres?|verre|glace|bracelet|matiere|materiau|boitier|cadran|diametre|taille|epaisseur|etanche|etancheite|resistance a l'eau|fonctions?|complications?|affichage|fermoir|boucle|reserve de marche|garantie|collection|lunette|couronne|style|reference|ref|ean|fond)\b/;

const cleanText = (value: string) =>
  value
    .replace(/\s*\n\s*/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join(", ")
    .replace(/\s+/g, " ")
    .replace(/\s*:\s*$/, "")
    .trim();

/**
 * A product page's characteristics, whatever the shop's markup: a label
 * element followed by a value element in the same row (`<tr><th><td>`,
 * `<dt><dd>`, `<span class="…label">` / `<span class="…value">`,
 * `<b>Label</b><p>Value</p>`), or « Label : valeur » in one line. Only
 * labels a watch's table uses are kept (`WATCH_LABEL`); the first one
 * of each label wins. Nothing is guessed: no table, no specs.
 */
export function readSpecs(html: string): CatalogSpec[] {
  const $ = load(html);
  $("script, style, noscript, nav, header, footer, svg").remove();
  // Several values in one cell (« Femme<br>Homme ») stay apart.
  $("br").replaceWith("\n");
  /** A cell's text; a cell made of several items lists them. */
  const cell = (el: Parameters<typeof $>[0]) => {
    const items = $(el)
      .children()
      .toArray()
      .map((child) => $(child).text().trim())
      .filter(Boolean);
    return items.length > 1 ? items.join("\n") : $(el).text();
  };
  const specs: CatalogSpec[] = [];
  const seen = new Set<string>();
  const add = (rawLabel: string, rawValue: string) => {
    const label = cleanText(rawLabel);
    const value = cleanText(rawValue);
    const key = foldLabel(label);
    if (!label || !value || seen.has(key)) return;
    if (!WATCH_LABEL.test(key)) return;
    if (value.length > 200 || foldLabel(value) === key) return;
    seen.add(key);
    specs.push({ label, value });
  };
  // `<dt>` / `<dd>` pairs.
  $("dt").each((_, dt) => {
    const dd = $(dt).next("dd");
    if (dd.length) add($(dt).text(), cell(dd[0]));
  });
  // Rows of two texts: a label element, then a value element.
  $("tr, li, div, p").each((_, row) => {
    const parts = $(row)
      .children()
      .toArray()
      .map((child) => ({ label: $(child).text(), value: cell(child) }))
      .filter((part) => part.label.trim());
    if (parts.length === 2 && cleanText(parts[0].label).length <= 60) {
      add(parts[0].label, parts[1].value);
    }
  });
  // « Label : valeur », one per line of an element of text.
  $("li, p, td, span, div").each((_, el) => {
    if ($(el).children().not("b, strong, em, i, span, br").length > 0) return;
    for (const line of $(el).text().split("\n")) {
      const match = line
        .replace(/\s+/g, " ")
        .trim()
        .match(/^([^:]{2,40}?)\s*:\s*(.{1,150})$/);
      if (match) add(match[1], match[2]);
    }
  });
  return specs;
}

/** A schema.org `additionalProperty` list as specs. */
function propertySpecs(value: unknown): CatalogSpec[] {
  const list = Array.isArray(value) ? value : value ? [value] : [];
  return list.flatMap((raw) => {
    if (!raw || typeof raw !== "object") return [];
    const record = raw as Record<string, unknown>;
    const label = text(record.name);
    const shown = Array.isArray(record.value)
      ? record.value
          .map((v) => text(v))
          .filter(Boolean)
          .join(", ")
      : text(record.value);
    return label && shown ? [{ label, value: shown }] : [];
  });
}

/** Merges spec lists, the first one of a label winning. */
export function mergeCatalogSpecs(...lists: CatalogSpec[][]): CatalogSpec[] {
  const out: CatalogSpec[] = [];
  const seen = new Set<string>();
  for (const spec of lists.flat()) {
    const key = foldLabel(spec.label);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(spec);
  }
  return out;
}

/** The value of the first spec whose folded label matches. */
export function specValue(
  specs: CatalogSpec[] | undefined,
  label: RegExp,
): string | undefined {
  return specs?.find((spec) => label.test(foldLabel(spec.label)))?.value;
}

/**
 * A product page in full: its JSON-LD `Product`, completed by the page's
 * characteristics table. A maker's reference or an EAN the table states
 * fills what the JSON-LD left empty, never replaces it.
 */
export function readProductPage(html: string): CatalogProduct | undefined {
  const product = readJsonLdProduct(html);
  if (!product) return undefined;
  const specs = mergeCatalogSpecs(product.specs ?? [], readSpecs(html));
  const reference = specValue(
    specs,
    /^(reference fabricant|reference fournisseur|reference constructeur|reference|ref)$/,
  );
  const ean = cleanGtin(specValue(specs, /^(code ean|ean)$/));
  return {
    ...product,
    specs: specs.length ? specs : undefined,
    reference: product.reference ?? reference,
    ean: product.ean ?? ean,
  };
}
