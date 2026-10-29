import { z } from "alepha";
import { $entity, db } from "alepha/orm";

/**
 * A product tracked from before links (epic 16). Products are now added by
 * pasting their link (`WatchedLink`); at startup, tracked products in a
 * supported shop become watched links and are disabled here
 * (`SeedService.migrateTrackedProducts`). Enabled rows still read by their
 * source's `collect()`: Steam ones by `steamAppId`. `manualPrice` is no
 * longer read (manual price entry was retired).
 */
export const trackedProductEntity = $entity({
  name: "tracked_products",
  schema: z.object({
    id: db.primaryKey(),
    sourceId: z.text(),
    title: z.text({ minLength: 1, maxLength: 300 }),
    url: z.text(),
    merchantId: z.text().optional(),
    categoryId: z.text().optional(),
    steamAppId: z.number().optional(),
    manualPrice: z.number().min(0).optional(),
    /**
     * Idealo.fr product page URL (price comparison across merchants), used
     * purely as an external "market reference price" to tell ScoringService
     * how good a deal really is beyond our own price history — see
     * {@link IdealoReferenceService}. Optional: most products won't have a
     * matching Idealo listing.
     */
    idealoUrl: z.text().optional(),
    /**
     * Last Idealo "best price" successfully scraped, cached so every
     * collection run doesn't re-scrape a bot-protected page. Kept even when
     * a later scrape attempt fails, so scoring still has a (stale) reference
     * rather than none at all.
     */
    idealoReferencePrice: z.number().min(0).optional(),
    /** When {@link idealoReferencePrice} was last (successfully or not) checked. */
    idealoCheckedAt: z.datetime().optional(),
    currency: db.default(z.text(), "EUR"),
    enabled: db.default(z.boolean(), true),
    createdAt: db.createdAt(),
    updatedAt: db.updatedAt(),
  }),
  indexes: [{ column: "sourceId" }],
});
