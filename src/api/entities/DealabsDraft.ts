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
    title: z.text({ minLength: 1, maxLength: 1000 }),
    /**
     * The generated title had to be cut to fit Dealabs' 140 characters
     * (epic 28). Such a title is never published as is: it is rewritten
     * once — by the selection agent or the owner — and approved.
     */
    titleTrimmed: z.boolean().optional(),
    /** When the current title was approved for Dealabs (rename once). */
    titleApprovedAt: z.datetime().optional(),
    /** `admin`, or the agent's name. */
    titleApprovedBy: z.text({ maxLength: 120 }).optional(),
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
    dealabsUrl: z.text({ maxLength: 2000 }).optional(),
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
    /**
     * Set when the text stops being generated (#131): the owner saved
     * their own title or description, or the selection agent replaced
     * the description. An edited draft is never regenerated; « Régénérer »
     * clears these.
     */
    editedAt: z.datetime().optional(),
    /** `owner`, or `agent:<name>` (the owner's edit always wins). */
    editedBy: z.text({ maxLength: 120 }).optional(),
    /**
     * Which description template wrote the text (`DESCRIPTION_TEMPLATE`
     * in `dealDescription.ts`), or `legacy` for the merchant text / title
     * fallback — so the debrief can compare posts by template.
     */
    templateVersion: z.text({ maxLength: 40 }).optional(),
    /**
     * Dealabs moderation after publication (epic 29), read by
     * `DealabsModerationService` — never answered by DealRadar.
     * `hidden`: masqué, waiting for a fix; `deleted`: removed; `ok`: live.
     */
    moderationStatus: z
      .enum(["hidden", "deleted", "ok"])
      .meta({ mode: "text" })
      .optional(),
    /** `incomplete:location-stock`, `incomplete:image`, `seller`… */
    moderationReason: z.text({ maxLength: 60 }).optional(),
    /** The moderators' message, or what the thread's page showed. */
    moderationMessage: z.text({ size: "rich" }).optional(),
    /** When the moderation outcome was first seen. */
    moderationAt: z.datetime().optional(),
    /** Last time the thread and the messages were read. */
    moderationCheckedAt: z.datetime().optional(),
    /** Adam closed the alert (« Vu »). */
    moderationDismissedAt: z.datetime().optional(),
    generatedAt: z.datetime(),
    createdAt: db.createdAt(),
    updatedAt: db.updatedAt(),
  }),
  indexes: [{ column: "dealId", unique: true }, { column: "status" }],
});
