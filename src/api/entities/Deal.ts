import { z } from "alepha";
import { $entity, db } from "alepha/orm";

/**
 * A tracked product/offer. Created once per (sourceId, externalId) and
 * refreshed on every collection run.
 */
export const dealEntity = $entity({
  name: "deals",
  schema: z.object({
    id: db.primaryKey(),
    sourceId: z.text(),
    externalId: z.text(),
    title: z.text({ minLength: 1, maxLength: 300 }),
    url: z.text(),
    imageUrl: z.text().optional(),
    /**
     * Short factual product description/feature summary scraped from the
     * merchant page (see {@link RawDeal.description} in DealSource.ts) —
     * real product info for the Dealabs draft, not an internal metric.
     */
    description: z.text({ size: "rich" }).optional(),
    merchantId: z.text().optional(),
    categoryId: z.text().optional(),
    currentPrice: z.number().min(0),
    /**
     * The merchant's own reference price (the struck-through "prix barré"
     * on the offer page), when the source exposes one. This — not
     * {@link oldPrice} — is what the "-42%" badge is computed from.
     */
    listPrice: z.number().min(0).optional(),
    /** Last price we observed ourselves, before the current one. */
    oldPrice: z.number().min(0).optional(),
    /**
     * External "market reference price" (currently: Idealo's lowest listed
     * price across merchants), cached at the time of the last collection —
     * see {@link IdealoReferenceService}. Lets the deal detail page plot it
     * alongside our own price history and classify the deal against the
     * wider market, not just our own (thin) history. Absent for most deals:
     * only {@link TrackedProduct.idealoUrl} products ever get one.
     */
    referencePrice: z.number().min(0).optional(),
    /**
     * Mirrors {@link TrackedProduct.idealoUrl} at collection time, so the
     * detail page can fetch {@link IdealoReferenceService.getPriceHistory}
     * on demand without a reverse lookup from `Deal` to `TrackedProduct`
     * (a link that otherwise doesn't exist — see `RawDeal.productId`).
     */
    idealoUrl: z.text().optional(),
    /**
     * Seller & product signals read from the offer page — see
     * {@link DealDetails} in DealSource.ts for what each one means. All
     * optional: a source that can't expose one leaves it absent, and
     * `ScoringService` treats absent as "unknown" (neutral), never as bad.
     */
    sellerName: z.text().optional(),
    soldByMerchant: z.boolean().optional(),
    shippedByMerchant: z.boolean().optional(),
    sellerRating: z.number().optional(),
    sellerSalesCount: z.number().optional(),
    offersCount: z.number().optional(),
    bestOtherOfferPrice: z.number().min(0).optional(),
    productRating: z.number().optional(),
    productReviewCount: z.number().optional(),
    recentPurchases: z.number().optional(),
    condition: z
      .enum(["new", "refurbished", "used"])
      .meta({ mode: "text" })
      .optional(),
    ean: z.text().optional(),
    /** Merchant's own "prix le plus bas des 30 derniers jours" (Omnibus). */
    lowestRecentPrice: z.number().min(0).optional(),
    /** What `listPrice` is: a real former price, or a "prix conseillé". */
    listPriceKind: z.enum(["regular", "rrp"]).meta({ mode: "text" }).optional(),
    /**
     * Same product (matched by EAN) at another merchant we can read —
     * see `MarketReferenceService`. The cross-check that tells a real deal
     * from a price that is simply the going rate everywhere.
     */
    marketPrice: z.number().min(0).optional(),
    marketPriceSource: z.text().optional(),
    marketPriceUrl: z.text().optional(),
    marketCheckedAt: z.datetime().optional(),
    /** Last time {@link DealDetails} were actually fetched for this deal. */
    detailsCheckedAt: z.datetime().optional(),
    /**
     * Past Dealabs deals for the same product (see `DealabsHistoryService`):
     * what the community already got it for. The lowest one is the "is
     * this really a good price?" bar a deal hunter actually uses.
     */
    dealabsLowestPrice: z.number().min(0).optional(),
    dealabsLowestAt: z.datetime().optional(),
    dealabsDealsCount: z.number().optional(),
    dealabsBestTemperature: z.number().optional(),
    /** JSON array of the matching past threads (price, date, °, link). */
    dealabsHistory: z.text({ size: "rich" }).optional(),
    dealabsCheckedAt: z.datetime().optional(),
    /**
     * All-time low across stores from a price-history service (today:
     * IsThereAnyDeal for Steam games, when `ITAD_API_KEY` is set).
     */
    historicalLowPrice: z.number().min(0).optional(),
    historicalLowAt: z.datetime().optional(),
    historicalLowSource: z.text().optional(),
    itadId: z.text().optional(),
    itadCheckedAt: z.datetime().optional(),
    currency: db.default(z.text(), "EUR"),
    discountPercentage: z.number().optional(),
    availability: db.default(
      z.enum(["in_stock", "out_of_stock", "unknown"]).meta({ mode: "text" }),
      "unknown",
    ),
    startDate: z.datetime().optional(),
    endDate: z.datetime().optional(),
    firstSeenAt: z.datetime(),
    lastSeenAt: z.datetime(),
    status: db.default(
      z.enum(["active", "expired", "archived"]).meta({ mode: "text" }),
      "active",
    ),
    score: db.default(z.number(), 0),
    createdAt: db.createdAt(),
    updatedAt: db.updatedAt(),
  }),
  indexes: [
    { column: "sourceId" },
    { column: "status" },
    { column: "score" },
    { columns: ["sourceId", "externalId"], unique: true },
  ],
});
