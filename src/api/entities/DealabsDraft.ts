import { z } from "alepha";
import { $entity, db } from "alepha/orm";

/**
 * A generated draft for a Dealabs post. Never posted automatically:
 * you review/edit it here, then copy it to Dealabs yourself.
 */
export const dealabsDraftEntity = $entity({
  name: "dealabs_drafts",
  schema: z.object({
    id: db.primaryKey(),
    dealId: z.text(),
    title: z.text({ minLength: 1, maxLength: 300 }),
    // Multi-line post body — well past z.text()'s 255-char default cap.
    body: z.text({ size: "rich" }),
    /**
     * Standalone paragraph for Dealabs' "Description" field — distinct
     * from {@link body}, which is the whole post (title + description)
     * meant for a single "copy everything" action.
     */
    description: z.text({ size: "rich" }).optional(),
    status: db.default(
      z.enum(["draft", "posted", "discarded"]).meta({ mode: "text" }),
      "draft",
    ),
    /** Dealabs URL the user pasted back after posting manually. */
    dealabsUrl: z.text({ maxLength: 500 }).optional(),
    /** Set once {@link dealabsUrl} has been confirmed to be a live post. */
    verifiedAt: z.datetime().optional(),
    /**
     * Auto-publish history, so a deal that already failed to post says so
     * instead of looking untouched: how many attempts, when the last one
     * ran, how it ended, and why it failed.
     */
    publishAttempts: z.number().optional(),
    lastPublishAttemptAt: z.datetime().optional(),
    lastPublishResult: z
      .enum(["success", "failed", "duplicate"])
      .meta({ mode: "text" })
      .optional(),
    lastPublishError: z.text({ size: "rich" }).optional(),
    /**
     * The last publication's steps (`PublishRun` as JSON, see
     * `publishSteps.ts`), so a failure at night can be read the next
     * morning: which phase, when, and why.
     */
    lastPublishSteps: z.text({ size: "rich" }).optional(),
    generatedAt: z.datetime(),
    createdAt: db.createdAt(),
    updatedAt: db.updatedAt(),
  }),
  indexes: [{ column: "dealId", unique: true }, { column: "status" }],
});
