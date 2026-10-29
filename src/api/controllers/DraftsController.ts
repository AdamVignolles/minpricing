import { $inject, z } from "alepha";
import { $repository } from "alepha/orm";
import { $action, HttpError } from "alepha/server";

import { dealEntity } from "../entities/Deal.ts";
import { dealabsDraftEntity } from "../entities/DealabsDraft.ts";
import { $adminSession } from "../services/AdminAuth.ts";
import {
  AutoPublishService,
  DealNotAvailableError,
  PublishRefusedError,
} from "../services/AutoPublishService.ts";
import { DealabsDraftService } from "../services/DealabsDraftService.ts";
import { DealabsDuplicateError } from "../services/DealabsPublisherService.ts";
import { DealabsSessionService } from "../services/DealabsSessionService.ts";
import { DealPageCheckService } from "../services/DealPageCheckService.ts";
import {
  PublishCancelledError,
  PublishProgressService,
} from "../services/PublishProgressService.ts";
import { PUBLISH_STEPS } from "../services/publishSteps.ts";
import {
  REMOTE_KEYS,
  RemoteScreenService,
} from "../services/RemoteScreenService.ts";

const draftResponseSchema = dealabsDraftEntity.schema;

const sessionStatusSchema = z.object({
  available: z.boolean(),
  connected: z.boolean(),
  savedAt: z.text().optional(),
  login: z
    .object({
      state: z.enum(["waiting", "saved", "failed", "cancelled"]),
      startedAt: z.text(),
      message: z.text({ size: "rich" }).optional(),
    })
    .optional(),
});

const publishRunSchema = z.object({
  runId: z.text(),
  dealId: z.text(),
  title: z.text({ size: "rich" }),
  trigger: z.enum(["button", "schedule", "collection"]),
  status: z.enum(["running", "done", "failed", "cancelled"]),
  startedAt: z.text(),
  finishedAt: z.text().optional(),
  updatedAt: z.text(),
  dealabsUrl: z.text({ maxLength: 500 }).optional(),
  error: z.text({ size: "rich" }).optional(),
  stopRequest: z.object({ by: z.text(), at: z.text() }).optional(),
  steps: z.array(
    z.object({
      id: z.enum(PUBLISH_STEPS.map((step) => step.id) as [string, ...string[]]),
      label: z.text(),
      status: z.enum([
        "pending",
        "running",
        "done",
        "skipped",
        "failed",
        "stopped",
      ]),
      startedAt: z.text().optional(),
      finishedAt: z.text().optional(),
      detail: z.text({ size: "rich" }).optional(),
      needsHuman: z.boolean().optional(),
    }),
  ),
});

const screenSchema = z.object({
  active: z.boolean(),
  label: z.text().optional(),
  url: z.text({ size: "long" }).optional(),
  image: z.text({ maxLength: 4_000_000 }).optional(),
  width: z.number(),
  height: z.number(),
});

export class DraftsController {
  protected drafts = $repository(dealabsDraftEntity);
  protected draftService = $inject(DealabsDraftService);
  protected dealabsSession = $inject(DealabsSessionService);
  protected autoPublisher = $inject(AutoPublishService);
  protected pageCheck = $inject(DealPageCheckService);
  protected screen = $inject(RemoteScreenService);
  protected deals = $repository(dealEntity);
  protected progress = $inject(PublishProgressService);

  /**
   * Dry run of the pre-publish check: opens the merchant page and says
   * whether the deal could go to Dealabs now. Publishes nothing.
   */
  publishCheck = $action({
    method: "GET",
    path: "/deals/:id/publish-check",
    use: [$adminSession()],
    schema: {
      params: z.object({ id: z.text() }),
      response: z.object({
        ok: z.boolean(),
        reason: z.text({ size: "rich" }).optional(),
        matchedPrice: z.number().optional(),
        status: z.number().optional(),
        title: z.text({ size: "rich" }).optional(),
        prices: z.array(z.number()).optional(),
        availability: z.text().optional(),
      }),
    },
    handler: async ({ params }) => {
      const deal = await this.deals.getById(params.id);
      const verdict = await this.pageCheck.check(deal);
      return {
        ok: verdict.ok,
        reason: verdict.ok ? undefined : verdict.reason,
        matchedPrice: verdict.ok ? verdict.matchedPrice : undefined,
        status: verdict.snapshot?.status,
        title: verdict.snapshot?.title.slice(0, 200),
        prices: verdict.snapshot?.prices,
        availability: verdict.snapshot?.availability,
      };
    },
  });

  /**
   * The Dealabs publication in progress (button, schedule or end of a
   * collection), step by step, and the last finished one. Cheap: the
   * console polls it every couple of seconds while a publish runs.
   */
  publishProgress = $action({
    method: "GET",
    path: "/dealabs/publish/progress",
    use: [$adminSession()],
    schema: {
      response: z.object({
        current: publishRunSchema.optional(),
        last: publishRunSchema.optional(),
      }),
    },
    handler: () => this.progress.get(),
  });

  /**
   * Stops the publication in progress at its next step, before anything
   * is posted. Admin session only (the agent token never writes here).
   * Refused once « Envoi » started: the post may already exist.
   */
  stopPublish = $action({
    method: "POST",
    path: "/dealabs/publish/stop",
    use: [$adminSession()],
    schema: {
      response: z.object({
        ok: z.boolean(),
        message: z.text({ size: "rich" }),
      }),
    },
    handler: () => this.progress.requestStop("vous"),
  });

  /** Is a Dealabs session saved for auto-publish, and is a login running? */
  dealabsSessionStatus = $action({
    method: "GET",
    path: "/dealabs/session",
    use: [$adminSession()],
    schema: { response: sessionStatusSchema },
    handler: () => this.dealabsSession.status(),
  });

  /**
   * Opens a visible Dealabs login window on this machine; the session is
   * saved automatically once you're logged in there. Poll
   * {@link dealabsSessionStatus} to follow it.
   */
  dealabsLogin = $action({
    method: "POST",
    path: "/dealabs/session/login",
    use: [$adminSession()],
    schema: { response: sessionStatusSchema },
    handler: () => {
      try {
        return this.dealabsSession.startLogin();
      } catch (error) {
        throw new HttpError({
          status: 400,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },
  });

  /**
   * « Écran distant »: a picture of the Dealabs window the server has open
   * (login or publishing), for when that window is on the VM's virtual
   * display. Polled by the console while a login or a publish runs.
   */
  dealabsScreen = $action({
    method: "GET",
    path: "/dealabs/screen",
    use: [$adminSession()],
    schema: { response: screenSchema },
    handler: () => this.screen.snapshot(),
  });

  /**
   * Your input on that window: a click (window pixels), a scroll, some
   * text, or one key. The text goes straight to the page, never logged.
   */
  dealabsScreenInput = $action({
    method: "POST",
    path: "/dealabs/screen/input",
    use: [$adminSession()],
    schema: {
      body: z.object({
        click: z.object({ x: z.number(), y: z.number() }).optional(),
        scroll: z.number().optional(),
        text: z.text({ size: "long", trim: false }).optional(),
        key: z.enum(REMOTE_KEYS).optional(),
      }),
      response: screenSchema,
    },
    handler: async ({ body }) => {
      try {
        if (body.click) await this.screen.click(body.click.x, body.click.y);
        if (body.scroll) await this.screen.scroll(body.scroll);
        if (body.text) await this.screen.type(body.text);
        if (body.key) await this.screen.press(body.key);
      } catch (error) {
        throw new HttpError({
          status: 409,
          message: error instanceof Error ? error.message : String(error),
        });
      }
      // Let the page react before the picture goes back.
      await new Promise((resolve) => setTimeout(resolve, 400));
      return this.screen.snapshot();
    },
  });

  /** Forgets the saved Dealabs session. */
  dealabsLogout = $action({
    method: "DELETE",
    path: "/dealabs/session",
    use: [$adminSession()],
    schema: { response: sessionStatusSchema },
    handler: () => this.dealabsSession.disconnect(),
  });

  /**
   * Every deal should be able to show a "Publier sur Dealabs" button, even
   * ones collected before a draft existed for it — so a missing draft is
   * backfilled here on first view rather than only produced by the next
   * collection run.
   */
  byDeal = $action({
    method: "GET",
    path: "/deals/:id/draft",
    use: [$adminSession()],
    schema: {
      params: z.object({ id: z.text() }),
      response: draftResponseSchema.nullable(),
    },
    handler: async ({ params }) => {
      const draft = await this.draftService.ensureDraftForDeal(params.id);
      return draft ?? null;
    },
  });

  update = $action({
    method: "PATCH",
    path: "/deals/:id/draft",
    use: [$adminSession()],
    schema: {
      params: z.object({ id: z.text() }),
      body: z.object({
        title: z.text().optional(),
        body: z.text().optional(),
        description: z.text().optional(),
        status: z.enum(["draft", "posted", "discarded"]).optional(),
        dealabsUrl: z.text().optional(),
      }),
      response: draftResponseSchema,
    },
    handler: async ({ params, body }) => {
      const existing = await this.drafts.findOne({
        where: { dealId: { eq: params.id } },
      });
      if (!existing) {
        throw new HttpError({
          status: 404,
          message: `No draft for deal ${params.id}`,
        });
      }
      return this.drafts.updateById(existing.id, body);
    },
  });

  /**
   * Read-only check that a Dealabs URL the user pasted back actually is a
   * live post of this draft. Never posts anything itself — it only fetches
   * the page the user says they published and looks for the draft title,
   * then marks the draft "posted" if it matches. This is how "verify +
   * save" happens without ever submitting to Dealabs on the user's behalf.
   */
  verify = $action({
    method: "POST",
    path: "/deals/:id/draft/verify",
    use: [$adminSession()],
    schema: {
      params: z.object({ id: z.text() }),
      body: z.object({ dealabsUrl: z.url() }),
      response: z.object({
        matched: z.boolean(),
        draft: draftResponseSchema,
      }),
    },
    handler: async ({ params, body }) => {
      const existing = await this.drafts.findOne({
        where: { dealId: { eq: params.id } },
      });
      if (!existing) {
        throw new HttpError({
          status: 404,
          message: `No draft for deal ${params.id}`,
        });
      }

      const host = new URL(body.dealabsUrl).hostname;
      if (!/(^|\.)dealabs\.com$/.test(host)) {
        throw new HttpError({
          status: 400,
          message: "Only dealabs.com links can be verified.",
        });
      }

      let matched = false;
      try {
        const response = await fetch(body.dealabsUrl, {
          headers: { "user-agent": "Mozilla/5.0 (DealRadar draft check)" },
        });
        if (response.ok) {
          const html = await response.text();
          const normalize = (value: string) =>
            value.toLowerCase().replace(/\s+/g, " ").trim();
          matched = normalize(html).includes(
            normalize(existing.title).slice(0, 40),
          );
        }
      } catch {
        matched = false;
      }

      // Not confirmed (page gone, moderated, unreachable, or another
      // post): the draft goes back to "to review" so auto-publish is
      // available again. A real duplicate is still caught by Dealabs' own
      // "already posted?" check during auto-publish.
      const draft = matched
        ? await this.drafts.updateById(existing.id, {
            status: "posted",
            dealabsUrl: body.dealabsUrl,
            verifiedAt: new Date().toISOString(),
          })
        : await this.drafts.updateById(existing.id, {
            status: "draft",
            dealabsUrl: body.dealabsUrl,
          });

      return { matched, draft };
    },
  });

  /**
   * Full auto-publish: logs into Dealabs with your saved session (see
   * `npm run dealabs:login`), fills the submission form from the draft +
   * deal data, and clicks submit for you. Unlike `verify`, this *does*
   * post to Dealabs on your behalf — it's gated on you having run the
   * login script yourself, so it only ever acts as you, never with
   * credentials it collected on its own.
   */
  autoPublish = $action({
    method: "POST",
    path: "/deals/:id/draft/auto-publish",
    use: [$adminSession()],
    schema: {
      params: z.object({ id: z.text() }),
      response: draftResponseSchema,
    },
    handler: async ({ params }) => {
      try {
        return await this.autoPublisher.publishDeal(params.id);
      } catch (error) {
        if (error instanceof PublishRefusedError) {
          throw new HttpError({ status: error.status, message: error.message });
        }
        if (error instanceof PublishCancelledError) {
          throw new HttpError({ status: 409, message: error.message });
        }
        if (error instanceof DealNotAvailableError) {
          throw new HttpError({
            status: 422,
            message: shortError(error.message),
          });
        }
        if (error instanceof DealabsDuplicateError) {
          throw new HttpError({
            status: 409,
            message: shortError(
              error.existingUrl && !error.message.includes(error.existingUrl)
                ? `${error.message} : ${error.existingUrl}`
                : error.message,
            ),
          });
        }
        throw new HttpError({
          status: 502,
          message:
            error instanceof Error
              ? shortError(error.message)
              : "Auto-publish failed for an unknown reason.",
        });
      }
    },
  });
}

/**
 * Batched calls carry their error in a field capped at 255 characters: the
 * debug-snapshot path stays in the server log and on the draft
 * (`lastPublishError`), the console only needs the reason.
 */
function shortError(message: string): string {
  const reason = message.replace(/\s*\(debug snapshot: [^)]*\)\s*$/, "");
  return reason.length > 240 ? `${reason.slice(0, 239)}…` : reason;
}
