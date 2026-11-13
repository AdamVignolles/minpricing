import { z } from "alepha";
import { $entity, db } from "alepha/orm";

/**
 * One product of a shop's catalogue (`CatalogService`), whether on sale
 * or not: the raw material of an outside comparator (the watch site,
 * through `/feed/catalog`). Deliberately apart from `deals`: no quality
 * gate, no score, no Dealabs draft, nothing the radar's console lists.
 * A row exists as soon as the shop's sitemap names the page; `price` and
 * the rest come with its first read (`lastReadAt`).
 */
export const catalogOfferEntity = $entity({
  name: "catalog_offers",
  schema: z.object({
    id: db.primaryKey(),
    /** A source of `config/watch-sources.json`. */
    sourceId: z.text({ maxLength: 60 }),
    /** The page URL (sitemap readers) or the shop's variant id (Shopify). */
    externalId: z.text({ maxLength: 2000 }),
    url: z.text({ maxLength: 2000 }),
    title: z.text({ maxLength: 1000 }).optional(),
    brand: z.text({ maxLength: 200 }).optional(),
    /** Maker's reference when the shop states one (`mpn`). */
    reference: z.text({ maxLength: 200 }).optional(),
    sku: z.text({ maxLength: 200 }).optional(),
    ean: z.text({ maxLength: 20 }).optional(),
    imageUrl: z.text({ maxLength: 2000 }).optional(),
    description: z.text({ size: "rich" }).optional(),
    price: z.number().min(0).optional(),
    listPrice: z.number().min(0).optional(),
    currency: z.text({ maxLength: 8 }).optional(),
    availability: db.default(
      z.enum(["in_stock", "out_of_stock", "unknown"]).meta({ mode: "text" }),
      "unknown",
    ),
    rating: z.number().optional(),
    reviewCount: z.number().optional(),
    /**
     * `pending`: named by the sitemap, not read yet. `active`: read, a
     * product of the wanted kind. `skipped`: read, not one (a ring on a
     * jeweller's site) — never read again. `gone`: the page answered
     * 404/410.
     */
    status: db.default(
      z.enum(["pending", "active", "skipped", "gone"]).meta({ mode: "text" }),
      "pending",
    ),
    firstSeenAt: z.datetime(),
    lastReadAt: z.datetime().optional(),
    /** Consecutive reads that failed (blocked, no product block…). */
    readFailures: db.default(z.number(), 0),
    createdAt: db.createdAt(),
    updatedAt: db.updatedAt(),
  }),
  indexes: [
    { column: "status" },
    { column: "updatedAt" },
    { columns: ["sourceId", "externalId"], unique: true },
  ],
});

/** A catalogue offer's price, one row per change. */
export const catalogPriceEntity = $entity({
  name: "catalog_price_history",
  schema: z.object({
    id: db.primaryKey(),
    offerId: z.text(),
    price: z.number().min(0),
    observedAt: z.datetime(),
    createdAt: db.createdAt(),
  }),
  indexes: [{ column: "offerId" }, { column: "createdAt" }],
});
