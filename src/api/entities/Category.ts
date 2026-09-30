import { z } from "alepha";
import { $entity, db } from "alepha/orm";

/**
 * A product category (e.g. "video-games", "electronics").
 */
export const categoryEntity = $entity({
  name: "categories",
  schema: z.object({
    id: db.primaryKey(z.text()),
    name: z.text({ minLength: 1, maxLength: 100 }),
    slug: z.text({ minLength: 1, maxLength: 100 }),
    createdAt: db.createdAt(),
  }),
  indexes: [{ column: "slug", unique: true }],
});
