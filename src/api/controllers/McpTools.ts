import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { $inject, z } from "alepha";
import { $tool } from "alepha/mcp";

import { AgentFilesService } from "../services/AgentFilesService.ts";
import { appDir } from "../services/appDir.ts";
import { MyDealabsPostsService } from "../services/MyDealabsPostsService.ts";
import { PublishScheduleService } from "../services/PublishScheduleService.ts";
import { AdminController } from "./AdminController.ts";
import { AgentsController } from "./AgentsController.ts";
import { DealsController } from "./DealsController.ts";
import { DraftsController } from "./DraftsController.ts";
import { SourcesController } from "./SourcesController.ts";
import { StatsController } from "./StatsController.ts";

const readOnly = { readOnlyHint: true, openWorldHint: false } as const;

/** Files an agent may read through `get_config`, by name: never a path. */
export const CONFIG_FILES = {
  "publish-rules": "publish-rules.json",
  collection: "collection.json",
  desirability: "desirability.json",
  "selection-lessons": "selection-lessons.md",
} as const;

type DealRow = Record<string, unknown>;

const COMPACT_KEYS = [
  "id",
  "title",
  "url",
  "sourceId",
  "merchantId",
  "categoryId",
  "currentPrice",
  "listPrice",
  "listPriceKind",
  "discountPercentage",
  "marketPrice",
  "marketPriceSource",
  "historicalLowPrice",
  "score",
  "hotChance",
  "status",
  "billingPeriod",
  "condition",
  "sellerName",
  "productRating",
  "productReviewCount",
  "dealabsBestTemperature",
  "freshAt",
  "freshReason",
  "droppedFrom",
  "firstSeenAt",
  "lastSeenAt",
  "onDealabs",
];

/** What an agent needs to choose among deals, without the long text fields. */
function compactDeal(deal: DealRow | null | undefined) {
  if (!deal) return null;
  return Object.fromEntries(
    COMPACT_KEYS.filter((key) => deal[key] !== undefined).map((key) => [
      key,
      deal[key],
    ]),
  );
}

/**
 * The read-only MCP server (`/mcp`, OAuth in `McpOAuthController`): every
 * tool reads, none writes, publishes or starts anything. Most of them call
 * the console's own GET actions so an agent sees exactly what the console
 * shows; `$adminSession()` lets them through only inside an authorized
 * `/mcp` request.
 */
export class McpTools {
  protected deals = $inject(DealsController);
  protected drafts = $inject(DraftsController);
  protected admin = $inject(AdminController);
  protected agents = $inject(AgentsController);
  protected sources = $inject(SourcesController);
  protected stats = $inject(StatsController);
  protected myPosts = $inject(MyDealabsPostsService);
  protected agentFiles = $inject(AgentFilesService);
  protected publishSchedule = $inject(PublishScheduleService);

  search_deals = $tool({
    title: "Rechercher des deals",
    description:
      "List deals collected by DealRadar, with filters and sort. Returns a compact row per deal (price, discount, score /100, hotChance = chance in % to reach 100° on Dealabs, freshness, onDealabs when it is already posted there). Deals under score 40 are hidden by the console. Use get_deal for the full detail of one deal.",
    annotations: readOnly,
    schema: {
      params: z.object({
        search: z.text().optional(),
        status: z.enum(["active", "expired", "archived"]).optional(),
        minScore: z.number().min(0).max(100).optional(),
        minDiscount: z.number().min(0).max(100).optional(),
        maxPrice: z.number().min(0).optional(),
        categoryId: z.text().optional(),
        sourceId: z.text().optional(),
        sortBy: z
          .enum([
            "relevance",
            "hot",
            "discount",
            "price-asc",
            "price-desc",
            "newest",
          ])
          .optional(),
        page: z.number().min(0).optional(),
        size: z.number().min(1).max(50).optional(),
      }),
    },
    handler: async ({ params }) => {
      const result = await this.deals.list.run({
        query: { status: "active", size: 20, ...params },
      });
      return {
        page: result.page,
        deals: (result.content as DealRow[]).map(compactDeal),
      };
    },
  });

  get_highlights = $tool({
    title: "Deals à la une",
    description:
      "The dashboard's rails: best discounts, newest deals, historical lows and the featured deal.",
    annotations: readOnly,
    schema: {
      params: z.object({ size: z.number().min(1).max(24).optional() }),
    },
    handler: async ({ params }) => {
      const result = await this.deals.highlights.run({ query: params });
      return {
        featured: compactDeal(result.featured as DealRow | null),
        bestDiscounts: (result.bestDiscounts as DealRow[]).map(compactDeal),
        newest: (result.newest as DealRow[]).map(compactDeal),
        historicalLows: (result.historicalLows as DealRow[]).map(compactDeal),
      };
    },
  });

  get_deal = $tool({
    title: "Détail d'un deal",
    description:
      "Everything about one deal: the stored row, the score breakdown (six criteria with French explanations, price references, warnings), price statistics, the Dealabs heat prediction and its reasons, and its Dealabs draft with publish attempts.",
    annotations: readOnly,
    schema: { params: z.object({ id: z.text() }) },
    handler: async ({ params }) => {
      const [deal, priceStats, draft] = await Promise.all([
        this.deals.detail.run({ params }),
        this.deals.priceStats.run({ params }).catch(() => undefined),
        this.drafts.byDeal.run({ params }).catch(() => undefined),
      ]);
      return { deal, priceStats, draft };
    },
  });

  get_price_history = $tool({
    title: "Historique de prix",
    description:
      "Price observations DealRadar recorded for a deal, plus the external references: past Dealabs threads for the product and the store's price curve when known.",
    annotations: readOnly,
    schema: { params: z.object({ id: z.text() }) },
    handler: async ({ params }) => {
      const [observed, references] = await Promise.all([
        this.deals.historyOf.run({ params }),
        this.deals.priceHistory.run({ params }).catch(() => undefined),
      ]);
      return { observed, references };
    },
  });

  list_sources = $tool({
    title: "Sources",
    description: "The deal sources (shops, APIs) with their type and state.",
    annotations: readOnly,
    handler: async () => ({ sources: await this.sources.listSources.run() }),
  });

  get_collection_status = $tool({
    title: "Collecte en cours et récentes",
    description:
      "Live progress of the current collection run (per source: status, step, counts) and the recent runs with their results (without their log lines).",
    annotations: readOnly,
    schema: {
      params: z.object({ runs: z.number().min(1).max(50).optional() }),
    },
    handler: async ({ params }) => {
      const [progress, runs] = await Promise.all([
        this.admin.collectProgress.run(),
        this.admin.runs.run({ query: { size: params.runs ?? 5 } }),
      ]);
      return { progress, runs: runs.map(({ logs: _logs, ...run }) => run) };
    },
  });

  get_agent_changes = $tool({
    title: "Modifications des agents",
    description:
      "Audit trail of what the scheduled agents changed through the agent API (configs, reports, proposals, tonight's publishing plan): who, when, why, and which values moved.",
    annotations: readOnly,
    schema: {
      params: z.object({ limit: z.number().min(1).max(200).optional() }),
    },
    handler: async ({ params }) => this.agentFiles.changes(params.limit ?? 30),
  });

  get_publish_schedule = $tool({
    title: "Plan de publication",
    description:
      "Tonight's publishing plan run by the app (or another Paris day's, YYYY-MM-DD): each planned time, its status (planned/running/done/skipped/cancelled/failed), the deal published or tried, the result and why; plus the ranked deals it draws from.",
    annotations: readOnly,
    schema: {
      params: z.object({
        date: z.text({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" }).optional(),
      }),
    },
    handler: async ({ params }) => this.publishSchedule.list(params.date),
  });

  get_stats = $tool({
    title: "Statistiques",
    description:
      "Dashboard statistics: deals by state, collection health, and publication stats (posted, last 7 days, pending drafts, failed attempts, Dealabs temperatures).",
    annotations: readOnly,
    handler: async () => {
      const [overview, publications, admin] = await Promise.all([
        this.stats.overview.run(),
        this.stats.publications.run(),
        this.admin.stats.run(),
      ]);
      return { overview, publications, admin };
    },
  });

  get_agent_shortlist = $tool({
    title: "Shortlist des agents",
    description:
      "The rule-filtered candidates the evening selector chooses from (same data the deals-select skill reads), with recent publication history.",
    annotations: readOnly,
    schema: {
      params: z.object({
        hours: z.number().min(1).max(168).optional(),
        days: z.number().min(0).max(60).optional(),
        limit: z.number().min(1).max(200).optional(),
        perCategory: z.number().min(1).max(50).optional(),
      }),
    },
    handler: ({ params }) => this.admin.agentReport.run({ query: params }),
  });

  get_agents_overview = $tool({
    title: "Agents",
    description:
      "What the scheduled agents did: publications per day over two weeks, temperatures reached, and the list of their reports (evening, debrief, weekly review, sources).",
    annotations: readOnly,
    handler: async () => {
      const [overview, reports] = await Promise.all([
        this.agents.agentsOverview.run(),
        this.agents.agentReportList.run(),
      ]);
      return { overview, reports };
    },
  });

  get_agent_health = $tool({
    title: "Santé des agents",
    description:
      "Each scheduled cloud routine (sélection, sources, bilan, revue): its last slot, whether it ran (left its dated file on the server), may still be running, or MISSED it, and the configs/proposals/schedules it changed. Check this first when something looks off.",
    annotations: readOnly,
    handler: () => this.agents.agentsHealth.run(),
  });

  get_agent_report = $tool({
    title: "Rapport d'agent",
    description:
      "One agent report in Markdown, by id (from get_agents_overview).",
    annotations: readOnly,
    schema: { params: z.object({ id: z.text() }) },
    handler: ({ params }) => this.agents.agentReportDetail.run({ params }),
  });

  get_config = $tool({
    title: "Configuration",
    description:
      "Read one of the tuning files the agents own: publish-rules (selection rules), collection (sources schedule, Amazon/Cdiscount pages), desirability (brand/product weights of the heat prediction), selection-lessons (lessons the selector applies).",
    annotations: readOnly,
    schema: {
      params: z.object({
        name: z.enum([
          "publish-rules",
          "collection",
          "desirability",
          "selection-lessons",
        ]),
      }),
    },
    handler: ({ params }) => {
      const file = CONFIG_FILES[params.name];
      const path = [
        join(appDir(), "config", file),
        join(process.cwd(), "config", file),
      ].find((candidate) => existsSync(candidate));
      if (!path) return { name: params.name, found: false };
      const text = readFileSync(path, "utf8");
      return {
        name: params.name,
        found: true,
        content: file.endsWith(".json") ? JSON.parse(text) : text,
      };
    },
  });

  get_my_dealabs_posts = $tool({
    title: "Nos posts Dealabs",
    description:
      "Our own deals on Dealabs (from our public profile, cached 1 h): title, price, temperature, comments, status and date.",
    annotations: readOnly,
    handler: async () => ({ posts: await this.myPosts.postsNow() }),
  });

  get_dealabs_session = $tool({
    title: "Session Dealabs",
    description:
      "Whether the server has a saved Dealabs session for auto-publishing, when it was saved, and any login in progress.",
    annotations: readOnly,
    handler: () => this.drafts.dealabsSessionStatus.run(),
  });
}
