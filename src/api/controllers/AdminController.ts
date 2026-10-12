import { z } from "alepha";
import { $inject } from "alepha";
import { jobExecutionEntity } from "alepha/api/jobs";
import { $logger } from "alepha/logger";
import { $repository } from "alepha/orm";
import { $action } from "alepha/server";

import { dealEntity } from "../entities/Deal.ts";
import { dealabsDraftEntity } from "../entities/DealabsDraft.ts";
import { priceHistoryEntity } from "../entities/PriceHistory.ts";
import { sourceEntity } from "../entities/Source.ts";
import { trackedProductEntity } from "../entities/TrackedProduct.ts";
import {
  CollectDealsJob,
  nextCollectionTime,
} from "../jobs/CollectDealsJob.ts";
import { $adminSession } from "../services/AdminAuth.ts";
import { CollectionProgressService } from "../services/CollectionProgressService.ts";
import { CollectionService } from "../services/CollectionService.ts";

export class AdminController {
  protected deals = $repository(dealEntity);
  protected sources = $repository(sourceEntity);
  protected drafts = $repository(dealabsDraftEntity);
  protected history = $repository(priceHistoryEntity);
  protected products = $repository(trackedProductEntity);
  protected jobs = $repository(jobExecutionEntity);
  protected log = $logger();
  protected collection = $inject(CollectionService);
  protected collectJob = $inject(CollectDealsJob);
  protected progress = $inject(CollectionProgressService);

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
   * Starts a collection run right now, without waiting for the next cron
   * tick. Returns immediately: the run takes many minutes (hundreds of
   * pages), so the console follows it through {@link collectProgress}
   * instead of holding an HTTP request open. Goes through the job itself,
   * so it shows up in the run history and never overlaps a cron run.
   */
  collectNow = $action({
    method: "POST",
    path: "/admin/collect",
    use: [$adminSession()],
    schema: {
      response: z.object({
        started: z.boolean(),
        message: z.text(),
      }),
    },
    handler: async () => {
      if (await this.progress.isRunning()) {
        return {
          started: false,
          message: "Une collecte est déjà en cours.",
        };
      }
      await this.progress.markManual();
      void this.collectJob.run.trigger().catch((error: unknown) => {
        this.log.error("Manual collection failed", error);
      });
      return { started: true, message: "Collecte lancée." };
    },
  });

  /**
   * Live state of the current (or last) collection run, polled by the
   * console's progress sidebar. `null` until a first run has started.
   */
  collectProgress = $action({
    method: "GET",
    path: "/admin/collect/progress",
    use: [$adminSession()],
    schema: {
      response: z.object({
        /** Next scheduled run (hourly by day, every 3 h at night). */
        nextRunAt: z.text(),
        progress: z
          .object({
            runId: z.text(),
            status: z.enum(["running", "done", "failed"]),
            startedAt: z.text(),
            finishedAt: z.text().optional(),
            updatedAt: z.text(),
            trigger: z.enum(["schedule", "manual"]),
            previousDurationMs: z.number().optional(),
            currentSourceId: z.text().optional(),
            sources: z.array(
              z.object({
                id: z.text(),
                name: z.text(),
                status: z.enum(["pending", "running", "done", "failed"]),
                step: z.text().optional(),
                done: z.number().optional(),
                total: z.number().optional(),
                collected: z.number().optional(),
                created: z.number().optional(),
                updated: z.number().optional(),
                error: z.text().optional(),
                summary: z.text({ size: "rich" }).optional(),
                skipped: z.number().optional(),
                warnings: z.number().optional(),
                links: z
                  .array(
                    z.object({
                      label: z.text({ size: "rich" }),
                      url: z.text(),
                    }),
                  )
                  .optional(),
                startedAt: z.text().optional(),
                finishedAt: z.text().optional(),
              }),
            ),
            events: z.array(
              z.object({
                at: z.text(),
                sourceId: z.text().optional(),
                level: z.enum(["info", "warn"]),
                message: z.text({ size: "rich" }),
              }),
            ),
          })
          .nullable(),
      }),
    },
    handler: async () => ({
      progress: (await this.progress.get()) ?? null,
      nextRunAt: nextCollectionTime(new Date()).toISOString(),
    }),
  });
}
