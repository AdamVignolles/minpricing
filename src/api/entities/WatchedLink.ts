import { z } from "alepha";
import { $entity, db } from "alepha/orm";

/**
 * A product added by pasting its link (console, or an agent). It is read
 * by its shop's own collector on each run of that source, through
 * `collect(products)`, and goes through exactly the pipeline collected
 * offers do — same `(sourceId, externalId)` key, so a product collection
 * also finds stays one deal. Watched hourly, then daily after
 * `watchUntil`, until « Retirer » or « Arrêter » (epic 33: an expired deal
 * no longer ends it); a refused link stays watched (its price may drop).
 * `removed`: taken out of the deals « ajoutés à la main » by hand — not
 * watched, and its deal follows the normal rules again.
 */
export const watchedLinkEntity = $entity({
  name: "watched_links",
  schema: z.object({
    id: db.primaryKey(),
    /** The link as pasted. */
    url: z.text({ maxLength: 2000 }),
    canonicalUrl: z.text({ maxLength: 2000 }),
    sourceId: z.text({ maxLength: 40 }),
    externalId: z.text({ maxLength: 2000 }),
    /** "admin", or the agent that added it. */
    addedBy: z.text({ maxLength: 80 }),
    status: db.default(
      z
        .enum(["pending", "ok", "refused", "failed", "ended", "removed"])
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
    /**
     * End of the hourly phase (14 days after the link was pasted). Since
     * epic 33 the watch itself never ends on its own: past this date the
     * product is read once a day (hourly again while « Baisse de prix »),
     * until « Retirer » or « Arrêter ».
     */
    watchUntil: z.datetime(),
    /**
     * Where the product stands (epic 33, `services/watchStatus.ts`):
     * `waiting` « Pas intéressant » (no real drop now), `price_drop`
     * « Baisse de prix », `published` « Publié » (our post live on
     * Dealabs), `on_dealabs` « Déjà sur Dealabs » (someone else's).
     * Recomputed after each read and each Dealabs re-check.
     */
    watchStatus: z
      .enum(["waiting", "price_drop", "published", "on_dealabs"])
      .meta({ mode: "text" })
      .optional(),
    watchStatusAt: z.datetime().optional(),
    /** Why, in French (« −22 % sous le prix le plus bas des 30 jours… »). */
    watchReason: z.text({ size: "rich" }).optional(),
    /** JSON list of the last status changes ({ at, from, to, reason }). */
    watchHistory: z.text({ size: "rich" }).optional(),
    createdAt: db.createdAt(),
    updatedAt: db.updatedAt(),
  }),
  indexes: [{ column: "sourceId" }, { column: "status" }],
});
