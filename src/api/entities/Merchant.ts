import { z } from "alepha";
import { $entity, db } from "alepha/orm";

/**
 * A merchant / retailer (Amazon, Cdiscount, Steam...).
 */
export const merchantEntity = $entity({
  name: "merchants",
  schema: z.object({
    id: db.primaryKey(z.text()),
    name: z.text({ minLength: 1, maxLength: 100 }),
    domain: z.text().optional(),
    createdAt: db.createdAt(),
  }),
  indexes: [{ column: "name", unique: true }],
});
