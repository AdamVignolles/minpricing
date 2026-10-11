import { z } from "alepha";
import { $inject, Alepha } from "alepha";
import { $repository, db, pageQuerySchema } from "alepha/orm";
import { $action } from "alepha/server";

import type { CloudflareBrowserBinding } from "../collectors/browser.ts";
import { dealEntity } from "../entities/Deal.ts";
import { priceHistoryEntity } from "../entities/PriceHistory.ts";
import { sourceEntity } from "../entities/Source.ts";
import { $adminSession } from "../services/AdminAuth.ts";
import type { StoredDealabsDeal } from "../services/DealabsHistoryService.ts";
import { IdealoReferenceService } from "../services/IdealoReferenceService.ts";
import { ItadService } from "../services/ItadService.ts";
import { PricingService } from "../services/PricingService.ts";
import { ScoringService } from "../services/ScoringService.ts";

const dealResponseSchema = dealEntity.schema;

const priceReferenceSchema = z.object({
  kind: z.enum(["lowest30d", "history", "regular", "rrp", "listed"]),
  label: z.text(),
  price: z.number(),
  trust: z.number(),
});

/** Wire shape of {@link ScoringService.evaluate}'s result. */
const analysisSchema = z.object({
  score: z.number(),
  verdict: z.enum(["excellent", "good", "fair", "weak"]),
  criteria: z.array(
    z.object({
      key: z.enum([
        "discount",
        "competition",
        "seller",
        "product",
        "history",
        "confidence",
      ]),
      label: z.text(),
      points: z.number(),
      max: z.number(),
      status: z.enum(["good", "neutral", "bad", "unknown"]),
      detail: z.text({ size: "rich" }),
    }),
  ),
  reference: priceReferenceSchema
    .extend({ discountPercentage: z.number() })
    .optional(),
  references: z.array(priceReferenceSchema),
  bestAlternative: z.object({ label: z.text(), price: z.number() }).optional(),
  warnings: z.array(z.text({ size: "rich" })),
});

/** Sort keys the UI offers, mapped to the repository's sort syntax. */
const SORTS: Record<string, string> = {
  relevance: "-score",
  discount: "-discountPercentage",
  "price-asc": "currentPrice",
  "price-desc": "-currentPrice",
  newest: "-firstSeenAt",
};

export class DealsController {
  protected deals = $repository(dealEntity);
  protected history = $repository(priceHistoryEntity);
  protected sources = $repository(sourceEntity);
  protected pricing = $inject(PricingService);
  protected scoring = $inject(ScoringService);
  protected idealoReference = $inject(IdealoReferenceService);
  protected itad = $inject(ItadService);
  protected alepha = $inject(Alepha);

  /** Same binding resolution as `CollectionService` — see `browser.ts`. */
  protected cloudflareBrowserBinding(): CloudflareBrowserBinding | undefined {
    if (!this.alepha.isServerless()) {
      return undefined;
    }
    const cloudflareEnv = this.alepha.get("cloudflare.env") as
      | Record<string, unknown>
      | undefined;
    return cloudflareEnv?.BROWSER as CloudflareBrowserBinding | undefined;
  }

  list = $action({
    method: "GET",
    path: "/deals",
    use: [$adminSession()],
    schema: {
      query: pageQuerySchema.extend({
        status: z.enum(["active", "expired", "archived"]).optional(),
        minScore: z.number().min(0).max(100).optional(),
        minDiscount: z.number().min(0).max(100).optional(),
        minPrice: z.number().min(0).optional(),
        maxPrice: z.number().min(0).optional(),
        categoryId: z.text().optional(),
        merchantId: z.text().optional(),
        sourceId: z.text().optional(),
        search: z.text().optional(),
        sortBy: z
          .enum(["relevance", "discount", "price-asc", "price-desc", "newest"])
          .optional(),
      }),
      response: db.page(dealResponseSchema),
    },
    handler: async ({ query }) => {
      const {
        page = 0,
        size = 10,
        sort,
        sortBy,
        status,
        minScore,
        minDiscount,
        minPrice,
        maxPrice,
        categoryId,
        merchantId,
        sourceId,
        search,
      } = query;

      const conditions: Record<string, unknown>[] = [];
      if (status) conditions.push({ status: { eq: status } });
      if (minScore !== undefined) conditions.push({ score: { gte: minScore } });
      if (minDiscount !== undefined) {
        conditions.push({ discountPercentage: { gte: minDiscount } });
      }
      if (minPrice !== undefined) {
        conditions.push({ currentPrice: { gte: minPrice } });
      }
      if (maxPrice !== undefined) {
        conditions.push({ currentPrice: { lte: maxPrice } });
      }
      if (categoryId) conditions.push({ categoryId: { eq: categoryId } });
      if (merchantId) conditions.push({ merchantId: { eq: merchantId } });
      if (sourceId) conditions.push({ sourceId: { eq: sourceId } });
      if (search) conditions.push({ title: { ilike: `%${search}%` } });

      const where = conditions.length > 0 ? { and: conditions } : {};

      return this.deals.paginate(
        {
          page,
          size,
          // No explicit sort: default to most-recent-first, not
          // relevance — a fresh visit should show what was just found,
          // not a score-ranked mix the user didn't ask for.
          sort: sort ?? (sortBy && SORTS[sortBy]) ?? SORTS.newest,
        },
        { where },
        { count: true },
      );
    },
  });

  /**
   * The rails the dashboard is built around, in one round-trip.
   *
   * "Historical low" is derived from the price history rather than stored
   * as a flag, so it can never drift from the observations it summarizes.
   */
  highlights = $action({
    method: "GET",
    path: "/deals/highlights",
    use: [$adminSession()],
    schema: {
      query: z.object({ size: z.number().min(1).max(24).optional() }),
      response: z.object({
        bestDiscounts: z.array(dealResponseSchema),
        newest: z.array(dealResponseSchema),
        historicalLows: z.array(dealResponseSchema),
        featured: dealResponseSchema.nullable(),
      }),
    },
    handler: async ({ query }) => {
      const size = query.size ?? 8;
      const active = { status: { eq: "active" as const } };

      const [bestDiscounts, newest, topScored] = await Promise.all([
        this.deals.findMany({
          where: { and: [active, { discountPercentage: { gte: 1 } }] },
          orderBy: { column: "discountPercentage", direction: "desc" },
          limit: size,
        }),
        this.deals.findMany({
          where: active,
          orderBy: { column: "firstSeenAt", direction: "desc" },
          limit: size,
        }),
        this.deals.findMany({
          where: active,
          orderBy: { column: "score", direction: "desc" },
          limit: size * 3,
        }),
      ]);

      const historicalLows: typeof topScored = [];
      for (const deal of topScored) {
        if (historicalLows.length >= size) break;
        const stats = await this.pricing.getStats(deal.id, deal.currentPrice);
        if (stats.historyPoints > 1 && stats.isNewHistoricalMin) {
          historicalLows.push(deal);
        }
      }

      return {
        bestDiscounts,
        newest,
        historicalLows,
        featured: bestDiscounts[0] ?? topScored[0] ?? null,
      };
    },
  });

  detail = $action({
    method: "GET",
    path: "/deals/:id",
    use: [$adminSession()],
    schema: {
      params: z.object({ id: z.text() }),
      response: dealResponseSchema,
    },
    handler: async ({ params }) => this.deals.getById(params.id),
  });

  historyOf = $action({
    method: "GET",
    path: "/deals/:id/history",
    use: [$adminSession()],
    schema: {
      params: z.object({ id: z.text() }),
      response: z.array(priceHistoryEntity.schema),
    },
    handler: async ({ params }) =>
      this.history.findMany({
        where: { dealId: { eq: params.id } },
        orderBy: { column: "observedAt", direction: "asc" },
      }),
  });

  /**
   * Exposes {@link PricingService.getStats}, which already existed but was
   * only reachable from the collection pipeline. The detail page turns it
   * into a plain-language verdict ("23 % below the average observed"), so
   * that sentence and the score have to be computed from the same place.
   */
  priceStats = $action({
    method: "GET",
    path: "/deals/:id/price-stats",
    use: [$adminSession()],
    schema: {
      params: z.object({ id: z.text() }),
      response: z.object({
        currentPrice: z.number(),
        minPrice: z.number(),
        avgPrice: z.number(),
        maxPrice: z.number(),
        isNewHistoricalMin: z.boolean(),
        historyPoints: z.number(),
        /**
         * Signed gap to the historical average, in percent (negative means
         * cheaper than usual). Null when a single observation makes an
         * "average" meaningless — the UI stays silent rather than claiming
         * a trend it cannot see.
         */
        vsAveragePercentage: z.number().nullable(),
        /**
         * External market reference price (Idealo's lowest listed price
         * across merchants), when one was ever scraped for this deal's
         * tracked product. Null for the vast majority of deals.
         */
        referencePrice: z.number().nullable(),
        /**
         * Same verdict {@link ScoringService.classifyDeal} would compute —
         * against the market reference price when available, our own
         * history otherwise.
         */
        classification: z.enum([
          "excellent",
          "good",
          "average",
          "overpriced",
          "unknown",
        ]),
        /**
         * The score explained criterion by criterion, recomputed from the
         * stored deal with the same {@link ScoringService.evaluate} the
         * collection pipeline uses — so it always adds up to `deal.score`
         * as of the last collection.
         */
        analysis: analysisSchema,
      }),
    },
    handler: async ({ params }) => {
      const deal = await this.deals.getById(params.id);
      const stats = await this.pricing.getStats(
        deal.id,
        deal.currentPrice,
        deal.referencePrice,
      );
      const source = await this.sources.findOne({
        where: { id: { eq: deal.sourceId } },
      });
      const analysis = this.scoring.evaluate(
        deal,
        stats,
        source?.type ?? "scrape",
      );

      return {
        ...stats,
        referencePrice: stats.referencePrice ?? null,
        classification: analysis.classification,
        analysis: {
          score: analysis.score,
          verdict: analysis.verdict,
          criteria: analysis.criteria,
          reference: analysis.reference,
          references: analysis.references,
          bestAlternative: analysis.bestAlternative,
          warnings: analysis.warnings,
        },
        vsAveragePercentage:
          stats.historyPoints > 1 && stats.avgPrice > 0
            ? Math.round(
                ((stats.currentPrice - stats.avgPrice) / stats.avgPrice) * 100,
              )
            : null,
      };
    },
  });

  /**
   * Idealo's own "évolution du prix" chart series, fetched live on demand
   * when the user opens a deal — not pre-collected/cached, since there are
   * no collection-run budget constraints here, only this one page view's
   * patience. See {@link IdealoReferenceService.getPriceHistory}: best
   * effort, returns `available: false` rather than erroring when Idealo
   * blocks the scrape or the deal has no `idealoUrl` at all.
   */
  idealoHistory = $action({
    method: "GET",
    path: "/deals/:id/idealo-history",
    use: [$adminSession()],
    schema: {
      params: z.object({ id: z.text() }),
      response: z.object({
        available: z.boolean(),
        points: z.array(z.object({ date: z.text(), price: z.number() })),
      }),
    },
    handler: async ({ params }) => {
      const deal = await this.deals.getById(params.id);
      if (!deal.idealoUrl) {
        return { available: false, points: [] };
      }
      const points = await this.idealoReference.getPriceHistory(
        deal.idealoUrl,
        () => this.cloudflareBrowserBinding(),
      );
      return {
        available: !!points && points.length > 0,
        points: points ?? [],
      };
    },
  });

  /**
   * The product's price history from outside sources, for the detail
   * page's chart: past Dealabs deals for the same product (stored by the
   * collection run), plus — for Steam games, when `ITAD_API_KEY` is set —
   * the Steam price curve from IsThereAnyDeal, fetched live.
   */
  priceHistory = $action({
    method: "GET",
    path: "/deals/:id/price-history",
    use: [$adminSession()],
    schema: {
      params: z.object({ id: z.text() }),
      response: z.object({
        dealabs: z.array(
          z.object({
            title: z.text(),
            price: z.number(),
            publishedAt: z.text(),
            temperature: z.number(),
            isHot: z.boolean(),
            merchant: z.text().optional(),
            url: z.text(),
          }),
        ),
        steam: z.array(
          z.object({
            date: z.text(),
            price: z.number(),
            regular: z.number().optional(),
          }),
        ),
      }),
    },
    handler: async ({ params }) => {
      const deal = await this.deals.getById(params.id);
      let dealabs: StoredDealabsDeal[] = [];
      try {
        dealabs = deal.dealabsHistory ? JSON.parse(deal.dealabsHistory) : [];
      } catch {
        dealabs = [];
      }
      const steam =
        deal.itadId && this.itad.enabled
          ? await this.itad.history(deal.itadId).catch(() => [])
          : [];
      return { dealabs, steam };
    },
  });
}
