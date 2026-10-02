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
  discountPercentage?: number;
  availability: string;
  startDate?: string;
  endDate?: string;
  firstSeenAt: string;
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
}

export interface Draft {
  id: string;
  title: string;
  body: string;
  description?: string;
  status: "draft" | "posted" | "discarded";
  dealabsUrl?: string;
  verifiedAt?: string;
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
  manualPrice?: number;
  steamAppId?: number;
  idealoUrl?: string;
  idealoReferencePrice?: number;
  currency: string;
}
