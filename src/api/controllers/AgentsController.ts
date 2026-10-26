import { $inject, z } from "alepha";
import { $action, HttpError } from "alepha/server";

import { $adminSession } from "../services/AdminAuth.ts";
import { AgentsService } from "../services/AgentsService.ts";

const rich = () => z.text({ size: "rich" });
const weightRow = z.object({ key: z.text(), value: z.number() });
const shop = z.object({
  limit: z.number(),
  bounds: z.array(z.number()),
  pages: z.array(z.object({ key: z.text(), enabled: z.boolean() })),
});

/**
 * The local agents' work for the console's Agents page: what they
 * published, the weights they select with, the lessons they learned and
 * their reports (evening, debrief, weekly review).
 */
export class AgentsController {
  protected agents = $inject(AgentsService);

  agentsOverview = $action({
    method: "GET",
    path: "/agents/overview",
    use: [$adminSession()],
    schema: {
      response: z.object({
        generatedAt: z.text(),
        kpis: z.object({
          published14d: z.number(),
          attempted14d: z.number(),
          hot14d: z.number(),
          medianTemperature: z.number().optional(),
          measured: z.number(),
        }),
        days: z.array(
          z.object({
            date: z.text(),
            times: z.array(z.text()),
            planned: z.number(),
            published: z.number(),
            ignored: z.number(),
            duplicates: z.number(),
            failed: z.number(),
          }),
        ),
        posts: z.array(
          z.object({
            date: z.text(),
            time: z.text(),
            title: rich(),
            url: rich().optional(),
            sourceId: z.text().optional(),
            categoryId: z.text().optional(),
            price: z.number().optional(),
            result: z.text(),
            reason: rich().optional(),
            temperature: z.number().optional(),
          }),
        ),
        rules: z.object({
          version: z.number(),
          updatedAt: z.text(),
          updatedBy: rich(),
          minScore: z.number(),
          minHotChance: z.number(),
          perDayMin: z.number(),
          perDayMax: z.number(),
          windowStart: z.text(),
          windowEnd: z.text(),
          publishDays: z.array(z.number()),
          maxPerCategoryPerDay: z.number(),
          categoryCaps: z.array(weightRow),
          excludedSources: z.array(z.text()),
          categoryAdjust: z.array(weightRow),
          sourceAdjust: z.array(weightRow),
          locked: z.array(z.text()),
        }),
        desirability: z.object({
          version: z.number(),
          updatedAt: z.text(),
          updatedBy: rich(),
          noBrandPenalty: z.number(),
          knownBrands: z.number(),
          brands: z.array(weightRow),
          keywords: z.array(weightRow),
        }),
        collection: z.object({
          amazon: shop,
          cdiscount: shop,
          sources: z.array(
            z.object({
              id: z.text(),
              enabled: z.boolean(),
              everyHours: z.number(),
              locked: z.boolean(),
            }),
          ),
        }),
        lessons: z.array(
          z.object({
            rule: rich(),
            proof: rich(),
            addedAt: z.text().optional(),
          }),
        ),
        changelog: z.array(
          z.object({ source: z.text(), title: rich(), body: rich() }),
        ),
      }),
    },
    handler: () => this.agents.overview(),
  });

  agentReportList = $action({
    method: "GET",
    path: "/agents/reports",
    use: [$adminSession()],
    schema: {
      response: z.array(
        z.object({
          id: z.text(),
          type: z.enum(["soiree", "debrief", "bilan", "sources", "autre"]),
          date: z.text(),
          title: rich(),
          summary: rich().optional(),
        }),
      ),
    },
    handler: () => this.agents.reports(),
  });

  agentReportDetail = $action({
    method: "GET",
    path: "/agents/reports/:id",
    use: [$adminSession()],
    schema: {
      params: z.object({ id: z.text() }),
      response: z.object({ id: z.text(), markdown: rich() }),
    },
    handler: ({ params }) => {
      const report = this.agents.report(params.id);
      if (!report)
        throw new HttpError({ status: 404, message: "Rapport introuvable" });
      return report;
    },
  });
}
