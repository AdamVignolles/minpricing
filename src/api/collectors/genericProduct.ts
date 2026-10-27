import type { DealDetails } from "./DealSource.ts";

export interface GenericProduct {
  title: string;
  price: number;
  listPrice?: number;
  currency: string;
  imageUrl?: string;
  description?: string;
  availability?: "in_stock" | "out_of_stock" | "unknown";
  details: DealDetails;
}

type Json = Record<string, unknown>;

const asArray = <T>(value: T | T[] | undefined): T[] =>
  value === undefined ? [] : Array.isArray(value) ? value : [value];

function num(value: unknown): number | undefined {
  if (typeof value === "number")
    return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string") return undefined;
  const parsed = Number(value.replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function str(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (value && typeof value === "object") {
    return str((value as Json).name ?? (value as Json).url);
  }
  return undefined;
}

/** Every JSON-LD object in the page, `@graph` flattened. */
function jsonLdNodes(html: string): Json[] {
  const nodes: Json[] = [];
  const walk = (value: unknown) => {
    if (Array.isArray(value)) return value.forEach(walk);
    if (!value || typeof value !== "object") return;
    nodes.push(value as Json);
    walk((value as Json)["@graph"]);
  };
  for (const match of html.matchAll(
    /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  )) {
    try {
      walk(JSON.parse(match[1]!.trim()));
    } catch {
      // Malformed block: ignore, others may still be valid.
    }
  }
  return nodes;
}

function hasType(node: Json, type: string): boolean {
  return asArray(node["@type"] as string | string[] | undefined).includes(type);
}

function meta(html: string, key: string): string | undefined {
  const tag = html.match(
    new RegExp(`<meta[^>]+(?:property|name)=["']${key}["'][^>]*>`, "i"),
  )?.[0];
  return tag?.match(/content=["']([^"']*)["']/i)?.[1]?.trim() || undefined;
}

function availabilityOf(
  value: unknown,
): "in_stock" | "out_of_stock" | "unknown" {
  const text = str(value) ?? "";
  if (/InStock|LimitedAvailability|PreOrder/i.test(text)) return "in_stock";
  if (/OutOfStock|SoldOut|Discontinued/i.test(text)) return "out_of_stock";
  return "unknown";
}

/**
 * Reads a product page's structured data (JSON-LD `Product`/`Offer`, with
 * OpenGraph as fallback). Returns undefined when no price can be found:
 * the caller then asks for a manual entry instead of guessing one.
 */
export function parseProductHtml(html: string): GenericProduct | undefined {
  const nodes = jsonLdNodes(html);
  const product = nodes.find((node) => hasType(node, "Product"));
  const offers = asArray(product?.offers as Json | Json[] | undefined).flatMap(
    (offer) =>
      hasType(offer, "AggregateOffer")
        ? asArray(offer.offers as Json | Json[] | undefined).concat(offer)
        : [offer],
  );

  let price: number | undefined;
  let listPrice: number | undefined;
  let currency: string | undefined;
  let availability: "in_stock" | "out_of_stock" | "unknown" = "unknown";
  let seller: string | undefined;

  const priced = offers
    .map((offer) => ({
      offer,
      value: num(offer.price) ?? num(offer.lowPrice),
    }))
    .filter((entry) => entry.value !== undefined && entry.value >= 0);
  const best = priced.sort((a, b) => a.value! - b.value!)[0];
  if (best) {
    price = best.value;
    currency = str(best.offer.priceCurrency);
    availability = availabilityOf(best.offer.availability);
    seller = str(best.offer.seller);
    for (const spec of asArray(
      best.offer.priceSpecification as Json | Json[] | undefined,
    )) {
      const type = str(spec["@type"]) ?? "";
      const value = num(spec.price);
      if (
        value !== undefined &&
        value > (price ?? 0) &&
        /List|Strike/i.test(type)
      ) {
        listPrice = value;
      }
    }
  }

  if (price === undefined) {
    price = num(
      meta(html, "product:price:amount") ?? meta(html, "og:price:amount"),
    );
    currency =
      currency ??
      meta(html, "product:price:currency") ??
      meta(html, "og:price:currency");
  }
  if (price === undefined) return undefined;

  const title =
    str(product?.name) ??
    meta(html, "og:title") ??
    html.match(/<title>([^<]*)/i)?.[1]?.trim();
  if (!title) return undefined;

  const rating = product?.aggregateRating as Json | undefined;
  const ean =
    str(product?.gtin13) ?? str(product?.gtin) ?? str(product?.gtin14);
  const brand = str(product?.brand);

  return {
    title:
      brand && !title.toLowerCase().includes(brand.toLowerCase())
        ? `${brand} ${title}`
        : title,
    price,
    listPrice: listPrice && listPrice > price ? listPrice : undefined,
    currency: currency ?? "EUR",
    imageUrl:
      asArray(product?.image as unknown)
        .map((image) => str(image))
        .find(Boolean) ?? meta(html, "og:image"),
    description: str(product?.description) ?? meta(html, "og:description"),
    availability,
    details: {
      sellerName: seller,
      productRating: num(rating?.ratingValue),
      productReviewCount: num(rating?.reviewCount ?? rating?.ratingCount),
      ean: ean && /^\d{8,14}$/.test(ean) ? ean : undefined,
    },
  };
}
