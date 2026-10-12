import { parsePriceFr } from "./browser.ts";
import type { DealDetails } from "./DealSource.ts";

/** Raw strings read off an AliExpress product page. */
export interface AliExpressPageText {
  currentPrice?: string;
  /** The struck-through "original" price, when the item is discounted. */
  originalPrice?: string;
  /** "4.8 903 Avis ౹ + 5 000 vendus" */
  reviewer?: string;
  storeName?: string;
  /** "Livraison gratuite Livraison : oct. 17 - 21 Service de livraison : Colissimo …" */
  shipping?: string;
}

/** "4.8 903 Avis ౹ + 5 000 vendus" → rating, review count, units sold. */
export function parseReviewer(text: string): {
  rating?: number;
  reviews?: number;
  sold?: number;
} {
  const flat = text.replace(/[  ]/g, " ").replace(/\s+/g, " ");
  // The rating always has a decimal ("4.8"), then the review count, whose
  // thousands are space-separated ("12 345"): read them in that order so
  // the rating's digit isn't glued onto the count.
  const review = flat.match(/(\d[.,]\d)\s+(\d[\d ]*?)\s*Avis/i);
  const sold = flat.match(/(\d[\d ]*)\s*vendus?/i);
  const count = (raw?: string) =>
    raw ? Number(raw.replace(/\D/g, "")) || undefined : undefined;
  return {
    rating: review ? Number(review[1].replace(",", ".")) : undefined,
    reviews: count(review?.[2]),
    sold: count(sold?.[1]),
  };
}

/**
 * AliExpress product page → {@link DealDetails}. AliExpress is a
 * marketplace: the seller is always a third-party store, and its
 * "original price" is set by that store — a "prix conseillé"-grade
 * reference, never a former selling price.
 */
export function parseAliExpressSignals(
  page: AliExpressPageText,
): DealDetails & {
  price?: number;
  originalPrice?: number;
} {
  const { rating, reviews } = parseReviewer(page.reviewer ?? "");
  const price = page.currentPrice ? parsePriceFr(page.currentPrice) : undefined;
  const original = page.originalPrice
    ? parsePriceFr(page.originalPrice)
    : undefined;
  return {
    price,
    originalPrice:
      original !== undefined && price !== undefined && original > price
        ? original
        : undefined,
    sellerName: page.storeName?.replace(/\s+/g, " ").trim() || undefined,
    soldByMerchant: false,
    // "Services logistique et livraison gérés par AliExpress" / local
    // carriers (Colissimo, Mondial Relay): shipped through the platform.
    shippedByMerchant: page.shipping
      ? /Colissimo|Mondial Relay|Colis Priv|Chronopost|gérés par AliExpress/i.test(
          page.shipping,
        )
      : undefined,
    productRating: rating,
    productReviewCount: reviews,
    condition: "new",
    listPriceKind: "rrp",
  };
}

/**
 * Brands sold both on AliExpress and by French retailers: only these are
 * cross-searched on Amazon/Cdiscount. A no-name product has nothing to be
 * compared with — searching for it only finds look-alikes.
 */
const KNOWN_BRANDS = [
  "xiaomi",
  "redmi",
  "poco",
  "realme",
  "oneplus",
  "samsung",
  "honor",
  "oppo",
  "motorola",
  "nothing",
  "google",
  "vivo",
  "huawei",
  "blackview",
  "doogee",
  "ulefone",
  "oukitel",
  "chuwi",
  "beelink",
  "minisforum",
  "geekom",
  "lenovo",
  "asus",
  "acer",
  "hp",
  "dell",
  "msi",
  "teclast",
  "anker",
  "ugreen",
  "baseus",
  "dji",
  "insta360",
  "soundcore",
  "edifier",
  "qcy",
  "amazfit",
  "soyo",
  "mllse",
  "trigkey",
  "ninkear",
  "dreame",
  "roborock",
  "ecovacs",
  "tp-link",
  "logitech",
  "jbl",
  "sony",
];

/** Words that describe, not identify: they stop a model name. */
const STOP_WORDS =
  /^(smartphone|téléphone|telephone|mobile|version|globale?|global|eu|eea|nfc|écran|ecran|amoled|processeur|mediatek|snapdragon|dimensity|batterie|appareil|photo|caméra|camera|charge|mini|pc|amd|intel|ryzen|core|ordinateur|portable|laptop|tablette|tablet|avec|pour|de|du|la|le|et|en|5g|4g|wifi|wi-fi)$/i;

/**
 * "Version Globale du Smartphone POCO F8 Ultra 5G Snapdragon…" → "POCO F8
 * Ultra". The brand, then the following words while they look like a
 * model (letters+digits, Pro/Max/Ultra…), at most 5 words.
 */
export function modelQuery(title: string): string | undefined {
  const words = title
    .replace(/[,|｜()+]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  const start = words.findIndex((word) =>
    KNOWN_BRANDS.includes(word.toLowerCase().replace(/[-®™]/g, "")),
  );
  if (start < 0) return undefined;
  const model = [words[start]];
  for (const word of words.slice(start + 1)) {
    if (model.length >= 5 || STOP_WORDS.test(word)) break;
    // Specs ("12GB", "6,83", "200MP") end the model name.
    if (
      /^\d+([.,]\d+)?(gb|go|mp|mah|w|hz|"|pouces)?$/i.test(word) &&
      model.length > 1 &&
      !/^\d{1,3}[a-z]?$/i.test(word)
    )
      break;
    model.push(word);
  }
  // A brand alone ("Xiaomi") is too vague to search for.
  return model.length >= 2 ? model.join(" ") : undefined;
}

/** Storage capacities stated in a title ("8GB+256GB", "512 Go SSD"). */
export function storageSizes(title: string): number[] {
  const sizes = [...title.matchAll(/(\d{2,4})\s?(?:GB|Go|To|TB)\b/gi)]
    .map((match) => Number(match[1]) * (/T/i.test(match[0]) ? 1024 : 1))
    // RAM is ≤ 32; storage starts at 64.
    .filter((size) => size >= 64);
  return [...new Set(sizes)];
}

/** Results that are around the product, not the product itself. */
export const ACCESSORY =
  /\b(coque|étui|etui|housse|verre trempé|protection|protège|film|chargeur|câble|cable|support|adaptateur|bracelet|stylet|skin|sticker|reconditionn|occasion|asian version)\b/i;

/** Listing-card badges worth keeping ("Prix le plus bas en 90 jours"). */
export function parseCardBadges(lines: string[]): { lowestInDays?: number } {
  const lowest = lines
    .map((line) => line.match(/Prix le plus bas en (\d+) jours/i)?.[1])
    .find(Boolean);
  return { lowestInDays: lowest ? Number(lowest) : undefined };
}
