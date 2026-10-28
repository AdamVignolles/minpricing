import { z } from "alepha";
import { $entity, db } from "alepha/orm";

/**
 * One planned publishing time of the evening plan, run by the app itself
 * (`PublishScheduleJob`) instead of a script waiting on Adam's PC. An
 * agent sets tonight's plan — the ranked deals and the times — and each
 * entry, when due, publishes the next suitable deal of that ranking
 * through `AutoPublishService.publishDeal`, like
 * `dealradar.mjs publish-queue` did.
 */
export const publishScheduleEntity = $entity({
  name: "publish_schedule",
  schema: z.object({
    id: db.primaryKey(),
    /** Paris day the plan belongs to (YYYY-MM-DD). */
    date: z.text({ maxLength: 10 }),
    plannedAt: z.datetime(),
    status: db.default(
      z
        .enum(["planned", "running", "done", "skipped", "cancelled", "failed"])
        .meta({ mode: "text" }),
      "planned",
    ),
    /** How the entry ended: the outcome of its last attempt. */
    result: z
      .enum(["success", "duplicate", "unavailable", "failed", "dry-run"])
      .meta({ mode: "text" })
      .optional(),
    /** The deal published (or last tried) by this entry. */
    dealId: z.text().optional(),
    title: z.text({ size: "rich" }).optional(),
    dealabsUrl: z.text({ maxLength: 500 }).optional(),
    /** Why it was skipped, failed or cancelled; or the dry-run verdict. */
    note: z.text({ size: "rich" }).optional(),
    /** Check the merchant page only, publish nothing. */
    dryRun: db.default(z.boolean(), false),
    preparedBy: z.text({ maxLength: 80 }),
    executedAt: z.datetime().optional(),
    createdAt: db.createdAt(),
    updatedAt: db.updatedAt(),
  }),
  indexes: [{ column: "date" }, { column: "status" }],
});
