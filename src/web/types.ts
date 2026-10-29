/**
 * View models for the console.
 *
 * Deliberately written out rather than inferred from the ORM entities:
 * these describe what actually arrives over the wire (ISO date strings,
 * optional columns absent rather than null), and keep the React bundle
 * free of any dependency on the database layer's types.
 */

export interface Deal {
  id: string;
  sourceId: string;
  externalId: string;
  title: string;
  url: string;
  imageUrl?: string;
  description?: string;
  merchantId?: string;
  categoryId?: string;
  currentPrice: number;
  /** Merchant's reference price; the discount is computed from this. */
  listPrice?: number;
  /** Previous price we observed ourselves. */
  oldPrice?: number;
  currency: string;
  /** "month" for plans and boxes: prices are per month. */
  billingPeriod?: "month";
  discountPercentage?: number;
  availability: string;
  startDate?: string;
  endDate?: string;
  firstSeenAt: string;
  /**
   * When the deal last became "new": first seen, or a real price drop.
   * Seen again at the same price, it keeps this date.
   */
  freshAt?: string;
  freshReason?: "new" | "price-drop";
  /** Price before that drop. */
  droppedFrom?: number;
  lastSeenAt: string;
  status: string;
  score: number;
  /**
   * External market reference price (Idealo's lowest listed price across
   * merchants), when the tracked product behind this deal has one
   * configured. Absent for most deals.
   */
  referencePrice?: number;
  /**
   * Mirrors the tracked product's Idealo URL, when configured — lets the
   * detail page offer to fetch Idealo's own price-history chart on demand.
   */
  idealoUrl?: string;
  /** Seller & product signals read from the offer page. */
  sellerName?: string;
  soldByMerchant?: boolean;
  shippedByMerchant?: boolean;
  sellerRating?: number;
  sellerSalesCount?: number;
  offersCount?: number;
  bestOtherOfferPrice?: number;
  productRating?: number;
  productReviewCount?: number;
  recentPurchases?: number;
  condition?: "new" | "refurbished" | "used";
  ean?: string;
  /** Merchant's own "prix le plus bas des 30 derniers jours". */
  lowestRecentPrice?: number;
  listPriceKind?: "regular" | "rrp";
  /** Same product (by EAN) at another merchant. */
  marketPrice?: number;
  marketPriceSource?: string;
  marketPriceUrl?: string;
  marketCheckedAt?: string;
  detailsCheckedAt?: string;
  /** Past Dealabs deals for the same product. */
  dealabsLowestPrice?: number;
  dealabsLowestAt?: string;
  dealabsDealsCount?: number;
  dealabsBestTemperature?: number;
  dealabsHistory?: string;
  dealabsCheckedAt?: string;
  /** All-time low from a price-history service (IsThereAnyDeal). */
  historicalLowPrice?: number;
  historicalLowAt?: string;
  historicalLowSource?: string;
  itadId?: string;
  itadCheckedAt?: string;
  /** Country the item ships from ("FR", "CN"), when known. */
  shipsFrom?: string;
  /** JSON array of {@link MarketComparison}: same product elsewhere. */
  marketComparisons?: string;
  /** Estimated chance (0-100) of reaching 100° on Dealabs. */
  hotChance?: number;
  /** JSON list of the reasons behind {@link hotChance}. */
  hotReasons?: string;
  /**
   * Already on Dealabs: our own published post, or someone else's live
   * deal at our price or cheaper. Lists only (the card is greyed out).
   */
  onDealabs?: {
    url: string;
    price: number;
    temperature: number;
    mine: boolean;
  };
  /** Added by pasting its link (see `WatchedLink`). */
  addedByLink?: { linkId: string; addedBy: string; watched: boolean };
}

/** Live state of a collection run (see `/admin/collect/progress`). */
export interface CollectionProgress {
  runId: string;
  status: "running" | "done" | "failed";
  startedAt: string;
  finishedAt?: string;
  updatedAt: string;
  trigger: "schedule" | "manual";
  previousDurationMs?: number;
  currentSourceId?: string;
  sources: Array<{
    id: string;
    name: string;
    status: "pending" | "running" | "done" | "failed";
    step?: string;
    done?: number;
    total?: number;
    collected?: number;
    created?: number;
    /** New deals the console shows (score ≥ 40). */
    createdVisible?: number;
    updated?: number;
    error?: string;
    summary?: string;
    skipped?: number;
    rejected?: number;
    warnings?: number;
    links?: Array<{ label: string; url: string }>;
    startedAt?: string;
    finishedAt?: string;
  }>;
  events: Array<{
    at: string;
    sourceId?: string;
    level: "info" | "warn";
    message: string;
  }>;
}

/** The same product at another merchant (cross-search). */
export interface MarketComparison {
  merchant: string;
  title: string;
  price: number;
  url: string;
  variantUnverified?: boolean;
}

/** One past Dealabs deal for the same product. */
export interface PastDeal {
  title: string;
  price: number;
  publishedAt: string;
  temperature: number;
  isHot: boolean;
  merchant?: string;
  url: string;
}

/** External price history for a deal (see `/deals/:id/price-history`). */
export interface ExternalPriceHistory {
  dealabs: PastDeal[];
  steam: Array<{ date: string; price: number; regular?: number }>;
}

export interface RefItem {
  id: string;
  name: string;
}

export interface PricePoint {
  price: number;
  observedAt: string;
}

/** One point of Idealo's own "évolution du prix" chart. */
export interface IdealoHistoryPoint {
  date: string;
  price: number;
}

export type DealClassification =
  | "excellent"
  | "good"
  | "average"
  | "overpriced"
  | "unknown";

export interface PriceStats {
  currentPrice: number;
  minPrice: number;
  avgPrice: number;
  maxPrice: number;
  isNewHistoricalMin: boolean;
  historyPoints: number;
  vsAveragePercentage: number | null;
  /** External market reference price (Idealo), when one was scraped. */
  referencePrice: number | null;
  classification: DealClassification;
  analysis: DealAnalysis;
  heat: HeatPrediction;
  /** Amazon product charted by Keepa (the deal, or the same product on Amazon). */
  keepa: { asin: string; sameProductOnAmazon: boolean } | null;
}

export type HeatLabel = "froid" | "tiède" | "prometteur" | "chaud";

export interface HeatPrediction {
  chance: number;
  label: HeatLabel;
  reasons: string[];
}

export type DealVerdict = "excellent" | "good" | "fair" | "weak";

export type CriterionStatus = "good" | "neutral" | "bad" | "unknown";

export interface ScoreCriterion {
  key:
    | "discount"
    | "competition"
    | "seller"
    | "product"
    | "history"
    | "confidence";
  label: string;
  points: number;
  max: number;
  status: CriterionStatus;
  detail: string;
}

export interface PriceReference {
  kind: "lowest30d" | "history" | "regular" | "rrp" | "listed";
  label: string;
  price: number;
  trust: number;
}

/** The score out of 100, explained criterion by criterion. */
export interface DealAnalysis {
  score: number;
  verdict: DealVerdict;
  criteria: ScoreCriterion[];
  /** The "normal price" the real discount was measured against. */
  reference?: PriceReference & { discountPercentage: number };
  references: PriceReference[];
  bestAlternative?: { label: string; price: number };
  warnings: string[];
}

export interface Draft {
  id: string;
  title: string;
  body: string;
  description?: string;
  status: "draft" | "posted" | "discarded";
  dealabsUrl?: string;
  verifiedAt?: string;
  /** Auto-publish history. */
  publishAttempts?: number;
  lastPublishAttemptAt?: string;
  lastPublishResult?: "success" | "failed" | "duplicate";
  lastPublishError?: string;
  /** The last publication's steps (`PublishRun` as JSON). */
  lastPublishSteps?: string;
}

export interface Breakdown {
  id: string;
  name: string;
  count: number;
  averageDiscount: number | null;
}

export interface SourceStat {
  id: string;
  name: string;
  type: string;
  enabled: boolean;
  activeDeals: number;
  lastRunAt?: string;
  lastSuccessAt?: string;
  lastErrorAt?: string;
  lastError?: string;
}

export interface StatsOverview {
  totals: {
    activeDeals: number;
    expiredDeals: number;
    newLast24h: number;
    newLast7d: number;
    dealsWithDiscount: number;
    averageDiscount: number | null;
    bestDiscount: number | null;
    potentialSavings: number;
    averagePrice: number | null;
  };
  categories: Breakdown[];
  merchants: Breakdown[];
  discountBuckets: Array<{ label: string; count: number }>;
  dealsPerDay: Array<{ date: string; count: number }>;
  sources: SourceStat[];
}

export interface PublicationStats {
  posted: number;
  postedLast7d: number;
  pendingDrafts: number;
  failedAttempts: number;
  lastPostedAt?: string;
  averageTemperature: number | null;
  hotPosts: number;
  totalPosts: number;
  bestPosts: Array<{
    id: string;
    title: string;
    temperature: number;
    merchant?: string;
    url: string;
    publishedAt: string;
  }>;
}

export interface DealsPage {
  content: Deal[];
  page: { number: number; size: number; totalElements?: number };
}

export interface CollectionRunLogEntry {
  timestamp: number;
  level: string;
  message: string;
  data?: unknown;
}

export interface CollectionRun {
  id: string;
  status: string;
  attempt: number;
  startedAt?: string;
  completedAt?: string;
  durationMs: number | null;
  error?: string;
  triggeredBy?: string;
  logs: CollectionRunLogEntry[];
}

export interface TrackedProduct {
  id: string;
  sourceId: string;
  title: string;
  url: string;
  steamAppId?: number;
  currency: string;
  /** False once migrated to a watched link. */
  enabled: boolean;
}
