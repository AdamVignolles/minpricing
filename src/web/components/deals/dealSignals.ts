import type { Deal, PriceReference, RefItem } from "../../types.ts";
import * as f from "../ui/format.ts";

/**
 * The four things Adam reads first on a deal (epic 30, audit F20): the
 * price and what its drop is measured against, whether it is already on
 * Dealabs, its chances there, and who sells it with what reviews. One
 * wording, shared by the « Bons plans » table and the deal page's header.
 */

/** Short name of a price reference, for a table cell. */
export const REFERENCE_SHORT: Record<PriceReference["kind"], string> = {
  lowest30d: "plus bas 30 j",
  history: "plus bas relevé",
  regular: "prix habituel",
  rrp: "prix conseillé",
  listed: "prix barré",
};

export interface DropSignal {
  /** Drop in %, rounded; 0 for a free item. */
  percent: number;
  /** What it is measured against, short (« plus bas 30 j »). */
  against: string;
  /** The reference price, when known. */
  price?: number;
  /** A trusted reference (shop's 30-day low, regular price, our history). */
  trusted: boolean;
  free: boolean;
}

/**
 * The real drop: the score's own reference when the row carries it,
 * else the merchant's struck price (never trusted alone).
 */
export function dropSignal(deal: Deal): DropSignal | undefined {
  if (deal.currentPrice === 0) {
    return { percent: 100, against: "gratuit", trusted: true, free: true };
  }
  const reference = deal.priceArgument?.reference;
  if (reference) {
    return {
      percent: Math.round(reference.discountPercentage),
      against: REFERENCE_SHORT[reference.kind] ?? reference.label,
      price: reference.price,
      // The score's trusted kinds: the shop's 30-day low or regular price,
      // our own history. A « prix conseillé » or a bare struck price is
      // indicative only.
      trusted: reference.kind !== "rrp" && reference.kind !== "listed",
      free: false,
    };
  }
  if ((deal.discountPercentage ?? 0) >= 1) {
    return {
      percent: Math.round(deal.discountPercentage as number),
      against: deal.listPriceKind === "rrp" ? "prix conseillé" : "prix barré",
      price: deal.listPrice,
      trusted: false,
      free: false,
    };
  }
  return undefined;
}

/**
 * Text the page read where a seller name should be (Cdiscount's offers
 * layer still loading, a filter button): not a seller.
 */
const NOT_A_SELLER = /^(passer les filtres|chargement des offres)/i;

export function sellerLine(deal: Deal, merchants?: RefItem[]): string {
  const merchant =
    merchants?.find((row) => row.id === deal.merchantId)?.name ??
    f.titleize(deal.merchantId ?? deal.sourceId);
  if (deal.soldByMerchant) return `Vendu par ${merchant}`;
  const name = deal.sellerName?.trim();
  if (name && !NOT_A_SELLER.test(name)) return `Vendeur : ${name}`;
  return "Vendeur non lu";
}

export function reviewsLine(deal: Deal): string {
  if (!deal.productRating) return "pas d'avis";
  const rating = deal.productRating.toLocaleString("fr-FR", {
    maximumFractionDigits: 1,
  });
  return `${rating}/5 · ${(deal.productReviewCount ?? 0).toLocaleString("fr-FR")} avis`;
}

export interface DealabsSignal {
  label: string;
  /** Mantine colour of the badge. */
  color: string;
  /** Ours and still live (or expired): the row is greyed. */
  posted: boolean;
}

/** Where the product stands on Dealabs, in a few words. */
export function dealabsSignal(deal: Deal): DealabsSignal {
  const on = deal.onDealabs;
  if (on?.mine && (on.status === "hidden" || on.status === "deleted")) {
    return {
      label:
        on.status === "hidden" ? "Masqué par Dealabs" : "Supprimé par Dealabs",
      color: "red",
      posted: false,
    };
  }
  if (on?.mine) {
    return {
      label: `Publié par vous${on.status === "expired" ? " · expiré" : on.temperature ? ` · ${on.temperature}°` : ""}`,
      color: "gray",
      posted: true,
    };
  }
  if (on) {
    return {
      label: `En ligne à ${f.price(on.price, deal.currency)}${on.temperature ? ` · ${on.temperature}°` : ""}`,
      color: "orange",
      posted: true,
    };
  }
  if (deal.dealabsLowestPrice) {
    return {
      label: `Posté avant à ${f.price(deal.dealabsLowestPrice, deal.currency)}${deal.dealabsBestTemperature ? ` · ${Math.round(deal.dealabsBestTemperature)}°` : ""}`,
      color: "blue",
      posted: false,
    };
  }
  return { label: "Jamais posté", color: "gray", posted: false };
}

/**
 * Our own post for this product still live on Dealabs, read from the
 * stored Dealabs history (threads tagged `mine`). Epic 32 attaches it to
 * the draft on the next status check; until then this is what says it.
 */
export function ourLivePost(
  deal: Deal,
): { price: number; publishedAt: string; temperature: number } | undefined {
  try {
    const threads = deal.dealabsHistory
      ? (JSON.parse(deal.dealabsHistory) as Array<{
          price: number;
          publishedAt: string;
          temperature: number;
          isExpired: boolean;
          mine?: boolean;
        }>)
      : [];
    return threads.find((thread) => thread.mine && !thread.isExpired);
  } catch {
    return undefined;
  }
}
