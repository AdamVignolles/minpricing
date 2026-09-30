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
    merchantId: z.text().optional(),
    categoryId: z.text().optional(),
    currentPrice: z.number().min(0),
    oldPrice: z.number().min(0).optional(),
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
