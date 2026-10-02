import { $inject, z } from "alepha";
import { DateTimeProvider } from "alepha/datetime";
import { $repository } from "alepha/orm";
import { $action, HttpError } from "alepha/server";

import { dealEntity } from "../entities/Deal.ts";
import { dealabsDraftEntity } from "../entities/DealabsDraft.ts";
import { $adminSession } from "../services/AdminAuth.ts";
import { DealabsDraftService } from "../services/DealabsDraftService.ts";
import {
  DealabsDuplicateError,
  DealabsPublisherService,
} from "../services/DealabsPublisherService.ts";

const draftResponseSchema = dealabsDraftEntity.schema;

export class DraftsController {
  protected drafts = $repository(dealabsDraftEntity);
  protected deals = $repository(dealEntity);
  protected draftService = $inject(DealabsDraftService);
  protected publisher = $inject(DealabsPublisherService);
  protected dateTime = $inject(DateTimeProvider);

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

      const draft = matched
        ? await this.drafts.updateById(existing.id, {
            status: "posted",
            dealabsUrl: body.dealabsUrl,
            verifiedAt: new Date().toISOString(),
          })
        : await this.drafts.updateById(existing.id, {
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
      const existing = await this.drafts.findOne({
        where: { dealId: { eq: params.id } },
      });
      if (!existing) {
        throw new HttpError({
          status: 404,
          message: `No draft for deal ${params.id}`,
        });
      }

      // Our own record of having already posted this one — cheap, no
      // browser needed, and the most common way "already published"
      // would happen (a double click, a retry after a flaky run, ...).
      if (existing.status === "posted") {
        throw new HttpError({
          status: 409,
          message: existing.dealabsUrl
            ? `Ce deal est déjà publié sur Dealabs : ${existing.dealabsUrl}`
            : "Ce deal est déjà marqué comme publié.",
        });
      }

      const deal = await this.deals.getById(params.id);

      try {
        const { dealabsUrl } = await this.publisher.publish(deal, existing);
        return this.drafts.updateById(existing.id, {
          status: "posted",
          dealabsUrl,
          verifiedAt: this.dateTime.nowISOString(),
        });
      } catch (error) {
        if (error instanceof DealabsDuplicateError) {
          throw new HttpError({
            status: 409,
            message: error.existingUrl
              ? `Ce deal semble déjà publié sur Dealabs : ${error.existingUrl}`
              : error.message,
          });
        }
        throw new HttpError({
          status: 502,
          message:
            error instanceof Error
              ? error.message
              : "Auto-publish failed for an unknown reason.",
        });
      }
    },
  });
}
