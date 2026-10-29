import { $inject, Alepha, type Infer, z } from "alepha";
import { $logger } from "alepha/logger";
import { $repository } from "alepha/orm";
import { $action, HttpError } from "alepha/server";

import { dealEntity } from "../entities/Deal.ts";
import { LinkCheckJob } from "../jobs/LinkCheckJob.ts";
import { $adminSession, $agentAuth } from "../services/AdminAuth.ts";
import { AgentFilesService } from "../services/AgentFilesService.ts";
import { CollectionService } from "../services/CollectionService.ts";
import { SUPPORTED_SHOPS } from "../services/linkResolver.ts";
import { initialLinkSteps, parseLinkSteps } from "../services/linkSteps.ts";
import {
  type AddLinkResult,
  type WatchedLink,
  WatchedLinkService,
} from "../services/WatchedLinkService.ts";

/** Links an agent may add per 24 h (each one opens a product page). */
export const AGENT_LINKS_PER_DAY = 20;

const stepSchema = z.object({
  id: z.text(),
  label: z.text(),
  status: z.enum(["pending", "running", "done", "skipped", "failed"]),
  detail: z.text({ size: "rich" }).optional(),
});

const linkSchema = z.object({
  id: z.text(),
  url: z.text({ maxLength: 1000 }),
  canonicalUrl: z.text({ maxLength: 1000 }),
  sourceId: z.text(),
  shop: z.text(),
  externalId: z.text({ maxLength: 500 }),
  addedBy: z.text(),
  status: z.enum(["pending", "ok", "refused", "failed", "ended"]),
  verdict: z.text({ size: "rich" }).optional(),
  steps: z.array(stepSchema),
  lastCheckedAt: z.text().optional(),
  watchUntil: z.text(),
  createdAt: z.text(),
  deal: z
    .object({
      id: z.text(),
      title: z.text({ size: "rich" }),
      imageUrl: z.text({ maxLength: 2000 }).optional(),
      currentPrice: z.number(),
      listPrice: z.number().optional(),
      discountPercentage: z.number().optional(),
      score: z.number().optional(),
      status: z.text(),
    })
    .optional(),
});

export type LinkView = Infer<typeof linkSchema>;

const addResponse = z.object({
  ok: z.boolean(),
  /** Refusal: why, in French (unsupported shop, not a product page…). */
  reason: z.text().optional(),
  message: z.text({ size: "rich" }).optional(),
  /** The product was already watched: that watch, renewed. */
  duplicate: z.boolean().optional(),
  link: linkSchema.optional(),
});

const shopsSchema = z.array(
  z.object({ sourceId: z.text(), label: z.text(), example: z.text() }),
);

/**
 * Adding a deal from its link (epic 16): `POST /links` resolves the link
 * at once (instant refusal for an unsupported shop or a non-product page),
 * starts watching it and queues its first check (`LinkCheckJob`); the
 * console then polls `GET /links/:id` for the steps and the verdict.
 * Agents add links through `POST /agent/links` (agent token, audited,
 * {@link AGENT_LINKS_PER_DAY} a day).
 */
export class LinksController {
  protected alepha = $inject(Alepha);
  protected log = $logger();
  protected links = $inject(WatchedLinkService);
  protected files = $inject(AgentFilesService);
  protected checkJob = $inject(LinkCheckJob);
  protected collection = $inject(CollectionService);
  protected deals = $repository(dealEntity);

  protected async view(link: WatchedLink): Promise<LinkView> {
    const deal = link.dealId
      ? await this.deals.findOne({ where: { id: { eq: link.dealId } } })
      : undefined;
    return {
      id: link.id,
      url: link.url,
      canonicalUrl: link.canonicalUrl,
      sourceId: link.sourceId,
      shop:
        SUPPORTED_SHOPS.find((shop) => shop.sourceId === link.sourceId)
          ?.label ?? link.sourceId,
      externalId: link.externalId,
      addedBy: link.addedBy,
      status: link.status,
      verdict: link.verdict,
      steps: parseLinkSteps(link.steps),
      lastCheckedAt: link.lastCheckedAt
        ? String(link.lastCheckedAt)
        : undefined,
      watchUntil: String(link.watchUntil),
      createdAt: String(link.createdAt),
      deal: deal
        ? {
            id: deal.id,
            title: deal.title,
            imageUrl: deal.imageUrl,
            currentPrice: deal.currentPrice,
            listPrice: deal.listPrice,
            discountPercentage: deal.discountPercentage,
            score: deal.score,
            status: deal.status,
          }
        : undefined,
    };
  }

  /** Queues the link's check; runs it here if the queue refuses. */
  protected async queueCheck(linkId: string): Promise<void> {
    try {
      await this.checkJob.run.push({ linkId });
    } catch (error) {
      this.log.warn("Link check not queued, running it inline", { error });
      void this.collection.checkLink(linkId);
    }
  }

  protected async respond(result: AddLinkResult) {
    if (!result.ok) {
      return { ok: false, reason: result.reason, message: result.message };
    }
    await this.queueCheck(result.link.id);
    return {
      ok: true,
      duplicate: result.duplicate,
      link: await this.view(await this.links.get(result.link.id)),
    };
  }

  addLink = $action({
    method: "POST",
    path: "/links",
    use: [$adminSession()],
    schema: {
      body: z.object({ url: z.text({ minLength: 1, maxLength: 2000 }) }),
      response: addResponse,
    },
    handler: async ({ body }) =>
      this.respond(await this.links.add(body.url, "admin")),
  });

  listLinks = $action({
    method: "GET",
    path: "/links",
    use: [$adminSession()],
    schema: {
      query: z.object({ size: z.number().optional() }),
      response: z.object({
        links: z.array(linkSchema),
        shops: shopsSchema,
      }),
    },
    handler: async ({ query }) => {
      const recent = await this.links.recent(
        Math.min(Math.max(query.size ?? 50, 1), 200),
      );
      return {
        links: await Promise.all(recent.map((link) => this.view(link))),
        shops: this.links.supportedShops(),
      };
    },
  });

  linkDetail = $action({
    method: "GET",
    path: "/links/:id",
    use: [$adminSession()],
    schema: {
      params: z.object({ id: z.text() }),
      response: linkSchema,
    },
    handler: async ({ params }) => this.view(await this.links.get(params.id)),
  });

  /** Reads the link again now (« Revérifier »). */
  recheckLink = $action({
    method: "POST",
    path: "/links/:id/check",
    use: [$adminSession()],
    schema: {
      params: z.object({ id: z.text() }),
      response: linkSchema,
    },
    handler: async ({ params }) => {
      const link = await this.links.get(params.id);
      if (link.status === "ended") {
        await this.links.add(link.canonicalUrl, link.addedBy);
      } else {
        await this.links.setSteps(link.id, initialLinkSteps());
      }
      await this.queueCheck(link.id);
      return this.view(await this.links.get(link.id));
    },
  });

  stopLink = $action({
    method: "POST",
    path: "/links/:id/stop",
    use: [$adminSession()],
    schema: {
      params: z.object({ id: z.text() }),
      response: linkSchema,
    },
    handler: async ({ params }) => {
      await this.links.get(params.id);
      return this.view(
        await this.links.end(params.id, "Surveillance arrêtée à la main."),
      );
    },
  });

  /**
   * An agent adds a link (`dealradar.mjs add-link`). Same checks as the
   * console; audited in `agent_writes`, {@link AGENT_LINKS_PER_DAY} a day.
   */
  agentAddLink = $action({
    method: "POST",
    path: "/agent/links",
    use: [$agentAuth()],
    schema: {
      body: z.object({
        url: z.text({ minLength: 1, maxLength: 2000 }),
        agent: z.text({ minLength: 1, maxLength: 80 }),
        reason: z.text({ size: "rich" }).optional(),
      }),
      response: addResponse,
    },
    handler: async ({ body }) => {
      const since = new Date(Date.now() - 86_400_000);
      if ((await this.files.countSince("link", since)) >= AGENT_LINKS_PER_DAY) {
        throw new HttpError({
          status: 429,
          message: `${AGENT_LINKS_PER_DAY} liens par 24 h au plus`,
        });
      }
      const request = this.alepha.store.get("alepha.http.request");
      const agent =
        request?.metadata?.agentCaller === "admin"
          ? `admin (${body.agent})`
          : body.agent;
      const result = await this.links.add(body.url, agent);
      if (result.ok) {
        await this.files.audit({
          agent,
          kind: "link",
          target:
            `links/${result.link.sourceId}/${result.link.externalId}`.slice(
              0,
              200,
            ),
          reason: body.reason,
          summary: result.link.canonicalUrl,
        });
      }
      return this.respond(result);
    },
  });
}
