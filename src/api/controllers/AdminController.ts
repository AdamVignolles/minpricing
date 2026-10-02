import { z } from "alepha";
import { $inject } from "alepha";
import { jobExecutionEntity } from "alepha/api/jobs";
import { $repository } from "alepha/orm";
import { $action } from "alepha/server";

import { dealEntity } from "../entities/Deal.ts";
import { dealabsDraftEntity } from "../entities/DealabsDraft.ts";
import { priceHistoryEntity } from "../entities/PriceHistory.ts";
import { sourceEntity } from "../entities/Source.ts";
import { trackedProductEntity } from "../entities/TrackedProduct.ts";
import { $adminSession } from "../services/AdminAuth.ts";
import { CollectionService } from "../services/CollectionService.ts";

export class AdminController {
  protected deals = $repository(dealEntity);
  protected sources = $repository(sourceEntity);
  protected drafts = $repository(dealabsDraftEntity);
  protected history = $repository(priceHistoryEntity);
  protected products = $repository(trackedProductEntity);
  protected jobs = $repository(jobExecutionEntity);
  protected collection = $inject(CollectionService);

  stats = $action({
    method: "GET",
    path: "/admin/stats",
    use: [$adminSession()],
    schema: {
      response: z.object({
        activeDeals: z.number(),
        expiredDeals: z.number(),
        draftsPending: z.number(),
        trackedProducts: z.number(),
        priceObservations: z.number(),
        sources: z.array(
          z.object({
            id: z.text(),
            name: z.text(),
            enabled: z.boolean(),
            lastRunAt: z.datetime().optional(),
            lastSuccessAt: z.datetime().optional(),
            lastErrorAt: z.datetime().optional(),
            lastError: z.text().optional(),
          }),
        ),
      }),
    },
    handler: async () => {
      const [
        activeDeals,
        expiredDeals,
        draftsPending,
        trackedProducts,
        priceObservations,
        sources,
      ] = await Promise.all([
        this.deals.count({ status: { eq: "active" } }),
        this.deals.count({ status: { eq: "expired" } }),
        this.drafts.count({ status: { eq: "draft" } }),
        this.products.count({}),
        this.history.count({}),
        this.sources.findMany(),
      ]);

      return {
        activeDeals,
        expiredDeals,
        draftsPending,
        trackedProducts,
        priceObservations,
        sources,
      };
    },
  });

  /**
   * Recent runs of the collection job, read from the `job_executions`
   * table Alepha already maintains — no bookkeeping of our own, and the
   * durations/errors shown in the admin are the ones the scheduler
   * actually recorded.
   */
  runs = $action({
    method: "GET",
    path: "/admin/runs",
    use: [$adminSession()],
    schema: {
      query: z.object({ size: z.number().min(1).max(50).optional() }),
      response: z.array(
        z.object({
          id: z.text(),
          status: z.text(),
          attempt: z.number(),
          startedAt: z.datetime().optional(),
          completedAt: z.datetime().optional(),
          durationMs: z.number().nullable(),
          error: z.text().optional(),
          triggeredBy: z.text().optional(),
          logs: z.array(
            z.object({
              timestamp: z.number(),
              level: z.text(),
              // Collector/job log lines can carry full error messages or
              // stack snippets well past the 255-char default cap.
              message: z.text({ size: "rich" }),
              data: z.any().optional(),
            }),
          ),
        }),
      ),
    },
    handler: async ({ query }) => {
      const rows = await this.jobs.findMany({
        where: { jobName: { eq: "deals.collect" } },
        orderBy: { column: "createdAt", direction: "desc" },
        limit: query.size ?? 20,
      });

      return rows.map((row) => {
        const started = row.startedAt
          ? new Date(row.startedAt as string | number).getTime()
          : undefined;
        const completed = row.completedAt
          ? new Date(row.completedAt as string | number).getTime()
          : undefined;

        return {
          id: row.id,
          status: row.status,
          attempt: row.attempt,
          startedAt: row.startedAt ?? undefined,
          completedAt: row.completedAt ?? undefined,
          durationMs:
            started !== undefined && completed !== undefined
              ? completed - started
              : null,
          error: row.error ?? undefined,
          triggeredBy: row.triggeredByName ?? row.triggeredBy ?? undefined,
          logs: (row.logs ?? []).map((entry) => ({
            timestamp: entry.timestamp,
            level: entry.level,
            message: entry.message,
            data: entry.data,
          })),
        };
      });
    },
  });

  /**
   * Runs the collection pipeline right now, for every enabled source, so
   * you don't have to wait for the next cron tick when testing/demoing.
   */
  collectNow = $action({
    method: "POST",
    path: "/admin/collect",
    use: [$adminSession()],
    schema: {
      response: z.array(
        z.object({
          sourceId: z.text(),
          collected: z.number(),
          created: z.number(),
          updated: z.number(),
          error: z.text().optional(),
        }),
      ),
    },
    handler: async () => this.collection.runAll(),
  });
}
