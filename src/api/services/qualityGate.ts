import { modelQuery } from "../collectors/aliexpressSignals.ts";
import { MIN_STEAM_REVIEWS } from "../collectors/SteamCollector.ts";
import { isComputer, isKnownPcBrand, parsePcSpecs } from "./pcSpecs.ts";

/** What the gate looks at: the offer's title and what its page told us. */
export interface QualityInput {
  title: string;
  sourceId: string;
  productRating?: number;
  productReviewCount?: number;
  soldByMerchant?: boolean;
  sellerRating?: number;
  sellerSalesCount?: number;
  /** Price and struck price, when the offer has one. */
  price?: number;
  listPrice?: number;
}

/**
 * Below this saving a discount isn't worth a post, however big the
 * percentage: a 3 € button at -50 % stays cold on Dealabs. Free items
 * (Epic's weekly games) are the exception.
 */
export const MIN_SAVING_EUR = 5;

/**
 * Review counts under which a game counts as unknown, per store (GOG's
 * audience is smaller than Steam's).
 */
const MIN_GAME_REVIEWS: Record<string, number> = {
  steam: MIN_STEAM_REVIEWS,
  gog: 300,
};

/**
 * Low-end laptop chips: machines Dealabs votes down every time (measured
 * on our own posts: 3°, 7°, 15°; an Athlon IdeaPad: "un peu de la merde…
 * Athlon 2 coeurs famélique"), whatever the price.
 */
const LOW_END_LAPTOP =
  /\b(celeron|n4000|n4020|n4100|n4120|n4500|n5000|n5030|n5095|n5100|n5105|atom|athlon|pentium|mediatek|kompanio)\b/i;
const CONSOLE_STORES = new Set(["nintendo", "playstation", "xbox"]);

const LAPTOP =
  /\b(pc portable|ordinateur portable|laptop|notebook|chromebook)\b/i;

/**
 * Why an offer isn't worth keeping, or `undefined` when it is. Applied at
 * collection time, before any scoring: a product people rate badly or a
 * seller with a poor record never makes a good deal, at any price.
 *
 * Only facts we actually read count against an offer — a missing rating
 * is "unknown", not "bad" (the score handles that).
 */
export function qualityIssue(offer: QualityInput): string | undefined {
  const reviews = offer.productReviewCount ?? 0;
  const ali = offer.sourceId === "aliexpress";

  if (LAPTOP.test(offer.title) && LOW_END_LAPTOP.test(offer.title)) {
    return "PC portable d'entrée de gamme (Celeron / N4000…)";
  }
  // PC buyers trust makers they know: a no-name laptop goes cold whatever
  // its price (Bvate, Ruzava, XWU… on our own posts).
  if (isComputer(offer.title) && !isKnownPcBrand(offer.title)) {
    return "PC de marque inconnue";
  }
  // 128 Go or less: full after Windows updates — called out on our posts.
  const storage = isComputer(offer.title)
    ? parsePcSpecs(offer.title).storageGb
    : undefined;
  if (storage !== undefined && storage <= 128) {
    return `PC avec ${storage} Go de stockage seulement`;
  }
  // Console stores: a "game" at under 3 € and -85 % or more is shovelware
  // nine times out of ten ("AAA Games Ultimate Collection": « on croirait
  // un scam »).
  if (
    CONSOLE_STORES.has(offer.sourceId) &&
    offer.price !== undefined &&
    offer.price > 0 &&
    offer.price < 3 &&
    offer.listPrice !== undefined &&
    offer.price <= offer.listPrice * 0.15
  ) {
    return "jeu bradé à moins de 3 € (souvent sans intérêt)";
  }
  if (
    offer.productRating !== undefined &&
    reviews >= 20 &&
    offer.productRating < (ali ? 4.5 : 4)
  ) {
    return `produit mal noté (${offer.productRating.toFixed(1).replace(".", ",")}/5 sur ${reviews} avis)`;
  }
  if (!offer.soldByMerchant && offer.sellerRating !== undefined) {
    if (offer.sellerRating < 4) {
      return `vendeur mal noté (${offer.sellerRating.toFixed(1).replace(".", ",")}/5)`;
    }
    if (offer.sellerSalesCount !== undefined && offer.sellerSalesCount < 50) {
      return `vendeur avec trop peu de ventes (${offer.sellerSalesCount})`;
    }
  }
  const minReviews = MIN_GAME_REVIEWS[offer.sourceId];
  if (
    minReviews !== undefined &&
    offer.productReviewCount !== undefined &&
    offer.productReviewCount < minReviews
  ) {
    return `jeu peu connu (${offer.productReviewCount} avis)`;
  }
  if (
    offer.price !== undefined &&
    offer.price > 0 &&
    offer.listPrice !== undefined &&
    offer.listPrice > offer.price &&
    offer.listPrice - offer.price < MIN_SAVING_EUR
  ) {
    return `économie trop faible (${(offer.listPrice - offer.price).toFixed(2).replace(".", ",")} €)`;
  }
  if (ali) {
    // A no-name AliExpress product can't be compared or trusted.
    if (!modelQuery(offer.title)) {
      return "produit AliExpress sans marque connue";
    }
    if (offer.productRating !== undefined && reviews < 20) {
      return `trop peu d'avis (${reviews})`;
    }
  }
  return undefined;
}
