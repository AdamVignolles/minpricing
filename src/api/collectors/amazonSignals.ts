import { parsePriceFr } from "./browser.ts";
import { parseCondition } from "./cdiscountOffers.ts";
import type { DealDetails } from "./DealSource.ts";

/** Raw strings read off an Amazon product page, before interpretation. */
export interface AmazonPageText {
  title: string;
  /** innerText of the price/buy-box column. */
  priceArea: string;
  /** `#acrPopover[title]`, e.g. "4,2 sur 5 étoiles". */
  ratingText?: string;
  /** `#acrCustomerReviewText`, e.g. "(4 650)" or "4 650 évaluations". */
  reviewsText?: string;
  sellerText?: string;
  shipperText?: string;
  /** Whole buy-box text, fallback when the dedicated fields are missing. */
  buyBoxText?: string;
  /** "Autres vendeurs sur Amazon … (4) dès 41,22€". */
  otherSellersText?: string;
  /** "Plus de 5 k achetés au cours du mois dernier". */
  boughtText?: string;
  /** Label of the struck-through price, e.g. "Prix conseillé : 64,99€". */
  basisText?: string;
}

function parseCount(text: string): number | undefined {
  const match = text.replace(/[  ]/g, " ").match(/(\d[\d\s.]*)/);
  if (!match) return undefined;
  const value = Number(match[1].replace(/[\s.]/g, ""));
  return Number.isFinite(value) ? value : undefined;
}

/**
 * "Plus de 5 k achetés", "Plus de 500 achetés", "1,2 k" → absolute count.
 */
export function parseBought(text: string): number | undefined {
  const flat = text.replace(/[  ]/g, " ");
  const match = flat.match(/(\d+(?:[.,]\d+)?)\s*(k|M)?\s*achet/i);
  if (!match) return undefined;
  const base = Number(match[1].replace(",", "."));
  const factor = match[2]?.toLowerCase() === "k" ? 1_000 : match[2] ? 1e6 : 1;
  return Math.round(base * factor);
}

/**
 * Who sells / ships. `sellerText`/`shipperText` are the buy box's own
 * fields; the summary line ("Expéditeur / Vendeur Amazon Retours …") says
 * whether one company does both, which is when the shipper field is absent.
 */
export function parseAmazonSeller(
  page: Pick<AmazonPageText, "sellerText" | "shipperText" | "buyBoxText">,
): { sellerName?: string; shipper?: string } {
  // Amazon decorates some seller names with rating stars ("Betashop ★★★★★").
  const clean = (value?: string) =>
    value
      ?.replace(/[★☆✩-✰]/g, "")
      .replace(/\s+/g, " ")
      .trim() || undefined;
  const sellerName = clean(page.sellerText);
  const shipper = clean(page.shipperText);
  const box = page.buyBoxText?.replace(/\s+/g, " ") ?? "";
  if (!shipper && /Expéditeur \/ Vendeur/i.test(box)) {
    return { sellerName, shipper: sellerName };
  }
  return { sellerName, shipper };
}

const isAmazon = (name?: string) => !!name && /^amazon(\.fr)?$/i.test(name);

/**
 * Turns the raw page strings into {@link DealDetails}. Amazon doesn't
 * expose a marketplace seller's rating on the product page (only on the
 * seller's own profile), nor an EAN — those stay undefined.
 */
export function parseAmazonSignals(
  page: AmazonPageText,
  price: number,
): DealDetails {
  const priceArea = page.priceArea.replace(/[  ]/g, " ");
  const lowest = priceArea.match(
    /Prix le plus bas des 30 derniers jours\s*:?\s*([\d\s]+[,.]\d{2})\s*€/i,
  );
  const lowestRecentPrice = lowest ? parsePriceFr(lowest[1]) : undefined;

  const rating = page.ratingText?.match(/(\d(?:[.,]\d)?)\s*sur\s*5/i);
  const { sellerName, shipper } = parseAmazonSeller(page);

  let offersCount: number | undefined;
  let bestOtherOfferPrice: number | undefined;
  const others = page.otherSellersText
    ?.replace(/[  ]/g, " ")
    .match(/\((\d+)\)\s*(?:dès|à partir de)\s*([\d\s]+[,.]\d{2})\s*€/i);
  if (others) {
    offersCount = Number(others[1]) + 1;
    // "Neuf & D'occasion (4) dès 41,22 €" mixes conditions: the cheapest
    // one may well be a used copy, so it only counts when new-only.
    const newOnly = !/occasion/i.test(page.otherSellersText ?? "");
    const from = parsePriceFr(others[2]);
    if (newOnly && from !== undefined && from < price) {
      bestOtherOfferPrice = from;
    }
  }

  const basis = page.basisText ?? "";
  const listPriceKind: DealDetails["listPriceKind"] = /conseill/i.test(basis)
    ? "rrp"
    : /plus bas/i.test(basis)
      ? "regular"
      : undefined;

  return {
    sellerName,
    soldByMerchant: sellerName ? isAmazon(sellerName) : undefined,
    shippedByMerchant: shipper ? isAmazon(shipper) : undefined,
    productRating: rating ? Number(rating[1].replace(",", ".")) : undefined,
    productReviewCount: page.reviewsText
      ? parseCount(page.reviewsText)
      : undefined,
    recentPurchases: page.boughtText ? parseBought(page.boughtText) : undefined,
    condition: parseCondition(page.title) ?? "new",
    lowestRecentPrice:
      lowestRecentPrice !== undefined && lowestRecentPrice > 0
        ? lowestRecentPrice
        : undefined,
    offersCount,
    bestOtherOfferPrice,
    listPriceKind,
  };
}
