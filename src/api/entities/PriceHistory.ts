import { z } from "alepha";
import { $entity, db } from "alepha/orm";

/**
 * A price observation for a deal. Only inserted when the price actually
 * changed (see PricingService) to avoid unbounded row growth.
 */
export const priceHistoryEntity = $entity({
  name: "price_history",
  schema: z.object({
    id: db.primaryKey(),
    dealId: z.text(),
    price: z.number().min(0),
    currency: db.default(z.text(), "EUR"),
    observedAt: z.datetime(),
    source: z.text(),
    createdAt: db.createdAt(),
  }),
  indexes: [{ column: "dealId" }, { column: "observedAt" }],
});
