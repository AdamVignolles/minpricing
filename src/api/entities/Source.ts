import { z } from "alepha";
import { $entity, db } from "alepha/orm";

/**
 * A deal source: how a set of tracked products is collected.
 *
 * - "manual": you add/update tracked products & their observed price
 *   yourself.
 * - "api": collected automatically from an official API (e.g. Steam).
 * - "scrape": auto-discovered by parsing a merchant's "deals" HTML page
 *   (e.g. Amazon, Cdiscount) — no official API, so it is inherently more
 *   fragile than "api" (layout changes, anti-bot blocking).
 */
export const sourceEntity = $entity({
  name: "sources",
  schema: z.object({
    id: db.primaryKey(z.text()),
    name: z.text({ minLength: 1, maxLength: 100 }),
    type: z.enum(["manual", "api", "scrape"]).meta({ mode: "text" }),
    enabled: db.default(z.boolean(), true),
    lastRunAt: z.datetime().optional(),
    lastSuccessAt: z.datetime().optional(),
    lastErrorAt: z.datetime().optional(),
    lastError: z.text().optional(),
    createdAt: db.createdAt(),
    updatedAt: db.updatedAt(),
  }),
  indexes: [{ column: "name", unique: true }],
});
