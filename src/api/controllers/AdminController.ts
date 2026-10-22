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
import type { StoredDealabsDeal } from "../services/DealabsHistoryService.ts";
import {
  type DealabsThread,
  isSameProduct,
  liveOnDealabs,
} from "../services/dealabsSearch.ts";
import { MyDealabsPostsService } from "../services/MyDealabsPostsService.ts";
import { dropSameListings } from "../services/sameListing.ts";
import { MIN_VISIBLE_SCORE } from "../services/ScoringService.ts";

const richText = () => z.text({ size: "rich" });

/** One of our Dealabs posts, as read from our public profile. */
const agentPostSchema = z.object({
  title: richText(),
  url: richText(),
  price: z.number(),
  temperature: z.number(),
  isHot: z.boolean(),
  isExpired: z.boolean(),
  publishedAt: z.text(),
  merchant: z.text().optional(),
});

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
  protected myPosts = $inject(MyDealabsPostsService);

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
          error: z.text({ size: "rich" }).optional(),
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
                createdVisible: z.number().optional(),
                updated: z.number().optional(),
                error: z.text({ size: "rich" }).optional(),
                summary: z.text({ size: "rich" }).optional(),
                skipped: z.number().optional(),
                rejected: z.number().optional(),
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

  /**
   * Compact digest for the local Claude agents (`.claude/agents/deal-*`):
   * the publishable candidates seen in the last `hours`, what we posted in
   * the last `days` with its live temperature, and our profile's posts.
   * Kept small on purpose — the agents read this instead of the database,
   * so its size is their token cost.
   */
  agentReport = $action({
    method: "GET",
    path: "/admin/agent-report",
    use: [$adminSession()],
    schema: {
      query: z.object({
        hours: z.number().min(1).max(168).optional(),
        /** 0 = candidates only (the selector doesn't need the history). */
        days: z.number().min(0).max(60).optional(),
        limit: z.number().min(1).max(100).optional(),
      }),
      response: z.object({
        generatedAt: z.text(),
        candidates: z.array(
          z.object({
            id: z.text(),
            title: richText(),
            sourceId: z.text(),
            categoryId: z.text().optional(),
            price: z.number(),
            referencePrice: z.number().optional(),
            discount: z.number().optional(),
            score: z.number(),
            hotChance: z.number().optional(),
            hotReasons: richText().optional(),
            seller: z.text().optional(),
            soldByMerchant: z.boolean().optional(),
            shipsFrom: z.text().optional(),
            rating: z.number().optional(),
            reviews: z.number().optional(),
            billingPeriod: z.text().optional(),
            dealabsPosts: z.number().optional(),
            dealabsBestTemperature: z.number().optional(),
            dealabsLowestPrice: z.number().optional(),
            freshAt: z.text().optional(),
          }),
        ),
        posted: z.array(
          z.object({
            dealId: z.text(),
            title: richText(),
            sourceId: z.text(),
            categoryId: z.text().optional(),
            price: z.number(),
            score: z.number(),
            hotChance: z.number().optional(),
            publishedAt: z.text().optional(),
            temperature: z.number().optional(),
            isHot: z.boolean().optional(),
            isExpired: z.boolean().optional(),
            url: richText().optional(),
          }),
        ),
        /** Failed or duplicate attempts in the period, by reason. */
        failures: z.record(z.text(), z.number()),
        /** Profile posts not matched to a publication (posted by hand). */
        otherPosts: z.array(agentPostSchema),
      }),
    },
    handler: async ({ query }) => {
      const now = Date.now();
      const since = new Date(now - (query.hours ?? 24) * 3_600_000);
      const postedSince = new Date(now - (query.days ?? 30) * 86_400_000);

      const threads = await this.myPosts
        .postsNow()
        .catch(() => [] as DealabsThread[]);
      const recentThreads = threads.filter(
        (thread) => new Date(thread.publishedAt) >= postedSince,
      );
      const toPost = (thread: DealabsThread) => ({
        title: thread.title,
        url: thread.url,
        price: thread.price,
        temperature: Math.round(thread.temperature),
        isHot: thread.isHot,
        isExpired: thread.isExpired,
        publishedAt: thread.publishedAt,
        merchant: thread.merchant,
      });

      // Candidates: visible, seen recently, with a draft never attempted —
      // or stopped once by Dealabs' "possible duplicate" panel, which used
      // to be taken as a duplicate even when it suggested other products.
      const seen = await this.deals.findMany({
        where: {
          and: [
            { status: { eq: "active" } },
            { score: { gte: MIN_VISIBLE_SCORE } },
            { lastSeenAt: { gte: since.toISOString() } },
          ],
        },
      });
      const drafts = seen.length
        ? await this.drafts.findMany({
            where: { dealId: { inArray: seen.map((deal) => deal.id) } },
          })
        : [];
      const draftOf = new Map(drafts.map((draft) => [draft.dealId, draft]));
      const candidates = dropSameListings(
        seen.filter((deal) => {
          const draft = draftOf.get(deal.id);
          if (!draft || draft.status !== "draft") return false;
          const panelOnly =
            draft.lastPublishResult === "duplicate" &&
            (draft.publishAttempts ?? 0) < 2 &&
            draft.lastPublishError?.startsWith(
              "Dealabs signale que ce deal existe déjà",
            );
          if (draft.publishAttempts && !panelOnly) return false;
          let history: StoredDealabsDeal[] = [];
          try {
            history = deal.dealabsHistory
              ? JSON.parse(deal.dealabsHistory)
              : [];
          } catch {
            // Unreadable history: treat as not on Dealabs.
          }
          if (liveOnDealabs(history, deal.currentPrice)) return false;
          return !recentThreads.some(
            (thread) =>
              !thread.isExpired &&
              isSameProduct(deal.title, deal.currentPrice, thread),
          );
        }),
      )
        .sort(
          (a, b) =>
            (b.hotChance ?? 0) - (a.hotChance ?? 0) || b.score - a.score,
        )
        .slice(0, query.limit ?? 25)
        .map((deal) => ({
          id: deal.id,
          title: deal.title.slice(0, 120),
          sourceId: deal.sourceId,
          categoryId: deal.categoryId,
          price: deal.currentPrice,
          referencePrice:
            deal.lowestRecentPrice ?? deal.listPrice ?? deal.oldPrice,
          discount: deal.discountPercentage,
          score: deal.score,
          hotChance: deal.hotChance,
          hotReasons: deal.hotReasons?.slice(0, 200),
          seller: deal.sellerName,
          soldByMerchant: deal.soldByMerchant,
          shipsFrom: deal.shipsFrom,
          rating: deal.productRating,
          reviews: deal.productReviewCount,
          billingPeriod: deal.billingPeriod,
          dealabsPosts: deal.dealabsDealsCount,
          dealabsBestTemperature: deal.dealabsBestTemperature,
          dealabsLowestPrice: deal.dealabsLowestPrice,
          freshAt: deal.freshAt,
        }));

      const report = {
        generatedAt: new Date(now).toISOString(),
        candidates,
        posted: [] as Array<{
          dealId: string;
          title: string;
          sourceId: string;
          categoryId?: string;
          price: number;
          score: number;
          hotChance?: number;
          publishedAt?: string;
          temperature?: number;
          isHot?: boolean;
          isExpired?: boolean;
          url?: string;
        }>,
        failures: {} as Record<string, number>,
        otherPosts: [] as ReturnType<typeof toPost>[],
      };
      if (query.days === 0) return report;

      // What we published, matched to the live thread on our profile.
      const attempts = await this.drafts.findMany({
        where: {
          and: [
            { publishAttempts: { gte: 1 } },
            { lastPublishAttemptAt: { gte: postedSince.toISOString() } },
          ],
        },
      });
      const matched = new Set<string>();
      for (const draft of attempts) {
        if (
          draft.status !== "posted" &&
          draft.lastPublishResult !== "success"
        ) {
          const reason = draft.lastPublishResult ?? "failed";
          report.failures[reason] = (report.failures[reason] ?? 0) + 1;
          continue;
        }
        const deal = await this.deals.findById(draft.dealId).catch(() => null);
        if (!deal) continue;
        const thread =
          threads.find(
            (candidate) =>
              draft.dealabsUrl !== undefined &&
              candidate.url === draft.dealabsUrl,
          ) ??
          threads.find(
            (candidate) =>
              !matched.has(candidate.id) &&
              isSameProduct(deal.title, deal.currentPrice, candidate),
          );
        if (thread) matched.add(thread.id);
        report.posted.push({
          dealId: deal.id,
          title: deal.title.slice(0, 80),
          sourceId: deal.sourceId,
          categoryId: deal.categoryId,
          price: deal.currentPrice,
          score: deal.score,
          hotChance: deal.hotChance,
          publishedAt: thread?.publishedAt ?? draft.lastPublishAttemptAt,
          temperature: thread ? Math.round(thread.temperature) : undefined,
          isHot: thread?.isHot,
          isExpired: thread?.isExpired,
          url: thread?.url ?? draft.dealabsUrl,
        });
      }
      report.otherPosts = recentThreads
        .filter((thread) => !matched.has(thread.id))
        .map(toPost);
      return report;
    },
  });
}
