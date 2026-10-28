import { z } from "alepha";
import { $entity, db } from "alepha/orm";

/**
 * One row per collection run, whatever its outcome: the journal the
 * console shows. Written when the run starts and closed in a `finally`,
 * so crashes, skipped ticks and "nothing due" runs leave a trace too.
 */
export const collectionRunEntity = $entity({
  name: "collection_runs",
  schema: z.object({
    id: db.primaryKey(),
    trigger: z.enum(["schedule", "manual"]).meta({ mode: "text" }),
    status: z
      .enum(["running", "ok", "partial", "failed", "skipped", "cancelled"])
      .meta({ mode: "text" }),
    skipReason: z.text({ size: "rich" }).optional(),
    startedAt: z.datetime(),
    endedAt: z.datetime().optional(),
    /** JSON: per-source `{id, ms, collected, created, updated, error…}`. */
    results: z.text({ size: "rich" }).optional(),
    /** JSON: ids of sources switched off by the collection config. */
    switchedOff: z.text({ size: "rich" }).optional(),
    error: z.text({ size: "rich" }).optional(),
    createdAt: db.createdAt(),
  }),
  indexes: [{ column: "startedAt" }],
});
