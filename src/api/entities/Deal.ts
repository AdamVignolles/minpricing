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
