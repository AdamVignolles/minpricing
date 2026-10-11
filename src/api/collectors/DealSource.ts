import type { Infer } from "alepha";

import type { trackedProductEntity } from "../entities/TrackedProduct.ts";

export type TrackedProduct = Infer<typeof trackedProductEntity.schema>;

/**
 * A raw offer, as returned by a collector, before normalization.
 */
export interface RawDeal {
  externalId: string;
  title: string;
  url: string;
  imageUrl?: string;
  price: number;
  /**
   * The merchant's reference/struck-through price, when the source exposes
   * one. Always greater than {@link price} — collectors must drop it
   * otherwise, so a bogus "-0%" or negative discount never reaches the UI.
   */
  listPrice?: number;
  currency: string;
  availability?: "in_stock" | "out_of_stock" | "unknown";
  merchantId?: string;
  categoryId?: string;
  /**
   * The merchant's own classification of the offer, as found while
   * collecting it: "amazon:toys" (the deals collection it was listed in),
   * "cdiscount:juniors/…" (its URL path), "amazon-crumb:Jeux et Jouets"
   * (product page breadcrumb). Mapped to a category by
   * `CategorizationService.fromHint` — far more reliable than guessing
   * from the title, which stays the fallback.
   */
  categoryHint?: string;
  /**
   * The {@link TrackedProduct} this offer was collected for, when the
   * collector worked off an explicit tracked product rather than
   * auto-discovering it (manual/Steam, not Amazon/Cdiscount `discover()`).
   * Lets the collection pipeline look up per-product config — e.g.
   * {@link TrackedProduct.idealoUrl} — without needing a `productId`
   * column on `Deal` itself.
   */
  productId?: string;
  /**
   * A short, factual product description/feature summary pulled from the
   * merchant page itself (e.g. Amazon's bullet points, Steam's short
   * description) — real product info, not anything DealRadar invents.
   * Optional: not every source can get one without extra requests.
   */
  description?: string;
  /**
   * Seller/product/reference signals read from the offer's own page, used
   * to judge whether the deal is really worth it (see `ScoringService`).
   * Absent when the collector skipped the detail fetch this run because
   * the deal was enriched recently (see {@link DiscoverContext}) — the
   * pipeline then keeps the previously stored values instead of blanking
   * them.
   */
  details?: DealDetails;
}

/**
 * Everything a collector could learn about an offer beyond its price.
 * Every field is optional: each source exposes a different subset, and a
 * missing signal is scored as "unknown" (neutral), never as "bad".
 */
export interface DealDetails {
  /** Who actually sells it (e.g. "Amazon", "Cdiscount", "MIGANG"). */
  sellerName?: string;
  /** Sold by the platform itself rather than a marketplace seller. */
  soldByMerchant?: boolean;
  /** Shipped/fulfilled by the platform (e.g. "Expédié par Cdiscount"). */
  shippedByMerchant?: boolean;
  /** Marketplace seller rating, out of 5. */
  sellerRating?: number;
  /** Marketplace seller's sales count, as shown by the platform. */
  sellerSalesCount?: number;
  /** How many offers exist for this product on the platform. */
  offersCount?: number;
  /** Cheapest *other* offer on the same platform, when one is listed. */
  bestOtherOfferPrice?: number;
  /** Product rating, out of 5. */
  productRating?: number;
  productReviewCount?: number;
  /** "Plus de 5 k achetés au cours du mois dernier" → 5000. */
  recentPurchases?: number;
  condition?: "new" | "refurbished" | "used";
  /** EAN/GTIN, when the page exposes one — the key for cross-merchant checks. */
  ean?: string;
  /**
   * The lowest price the merchant itself charged over the last 30 days,
   * which EU rules (Omnibus directive) require it to display next to any
   * announced price reduction. The most trustworthy reference there is:
   * it's the merchant's own legally-binding figure, not a "prix conseillé".
   */
  lowestRecentPrice?: number;
  /**
   * What {@link RawDeal.listPrice} actually is, when the page says so:
   * "regular" for a real former selling price (Steam's normal price), "rrp"
   * for a manufacturer's suggested price ("Prix conseillé" — often never
   * actually charged, so trusted much less).
   */
  listPriceKind?: "regular" | "rrp";
}

/**
 * Passed to {@link DealSource.discover} so a collector can skip expensive
 * per-offer detail fetches (an extra product page or two per deal) for
 * offers that were already enriched recently. Seller ratings and reviews
 * don't move every 30 minutes; re-reading them every run would multiply
 * page loads — and bot-detection risk — for nothing.
 */
export interface DiscoverContext {
  needsDetails(externalId: string): boolean;
  /**
   * Reports where the collector is ("Pages bons plans", 3 of 14) for the
   * console's live progress sidebar. Cheap to call often.
   */
  progress?(step: string, done?: number, total?: number): void;
}

/**
 * A collector turns a list of tracked products from one source into raw
 * offers. It must never throw for a single failing product: skip it and
 * let the caller log the failure, so one bad product never blocks the rest.
 *
 * `collect` covers products you tell it about (manual entry, or a specific
 * Steam appId). `discover` is for sources that can find deals on their own
 * (Steam specials API, Amazon/Cdiscount "bons plans" pages) — no tracked
 * product needed, it returns whatever it found this run.
 */
export interface DealSource {
  id: string;
  name: string;
  collect?(
    products: TrackedProduct[],
    context?: DiscoverContext,
  ): Promise<RawDeal[]>;
  discover?(context?: DiscoverContext): Promise<RawDeal[]>;
}
