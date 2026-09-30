import { z } from "alepha";
import { $entity, db } from "alepha/orm";

/**
 * A product you track. This is the unit of work for collectors:
 * - "manual" sources: you update `manualPrice` yourself when you notice a
 *   price on Amazon/Cdiscount (no reliable public API / scraping-safe access).
 * - "api" sources (e.g. Steam): `steamAppId` is used to fetch the price
 *   automatically from the official store API.
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
    currency: db.default(z.text(), "EUR"),
    enabled: db.default(z.boolean(), true),
    createdAt: db.createdAt(),
    updatedAt: db.updatedAt(),
  }),
  indexes: [{ column: "sourceId" }],
});
