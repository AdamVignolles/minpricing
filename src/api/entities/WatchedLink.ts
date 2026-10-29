import { z } from "alepha";
import { $entity, db } from "alepha/orm";

/**
 * A product added by pasting its link (console, or an agent). It is read
 * by its shop's own collector on each run of that source, through
 * `collect(products)`, and goes through exactly the pipeline collected
 * offers do — same `(sourceId, externalId)` key, so a product collection
 * also finds stays one deal. Watched until `watchUntil` or until its
 * deal expires; a refused link stays watched (its price may drop).
 */
export const watchedLinkEntity = $entity({
  name: "watched_links",
  schema: z.object({
    id: db.primaryKey(),
    /** The link as pasted. */
    url: z.text({ maxLength: 1000 }),
    canonicalUrl: z.text({ maxLength: 1000 }),
    sourceId: z.text({ maxLength: 40 }),
    externalId: z.text({ maxLength: 500 }),
    /** "admin", or the agent that added it. */
    addedBy: z.text({ maxLength: 80 }),
    status: db.default(
      z
        .enum(["pending", "ok", "refused", "failed", "ended"])
        .meta({ mode: "text" }),
      "pending",
    ),
    /** What the last check concluded, in French (shown as is). */
    verdict: z.text({ size: "rich" }).optional(),
    /** The last check's steps (JSON, see `linkSteps.ts`). */
    steps: z.text({ size: "rich" }).optional(),
    lastCheckedAt: z.datetime().optional(),
    /** The deal it became (also when refused: the archived row). */
    dealId: z.text().optional(),
    watchUntil: z.datetime(),
    createdAt: db.createdAt(),
    updatedAt: db.updatedAt(),
  }),
  indexes: [{ column: "sourceId" }, { column: "status" }],
});
