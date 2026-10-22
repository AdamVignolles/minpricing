import { z } from "alepha";
import { $inject, Alepha } from "alepha";
import { $repository, db, pageQuerySchema } from "alepha/orm";
import { $action } from "alepha/server";

import type { CloudflareBrowserBinding } from "../collectors/browser.ts";
import { dealEntity } from "../entities/Deal.ts";
import { dealabsDraftEntity } from "../entities/DealabsDraft.ts";
import { priceHistoryEntity } from "../entities/PriceHistory.ts";
import { sourceEntity } from "../entities/Source.ts";
import { $adminSession } from "../services/AdminAuth.ts";
import type { StoredDealabsDeal } from "../services/DealabsHistoryService.ts";
import {
  type DealabsThread,
  isSameProduct,
  liveOnDealabs,
  type OnDealabs,
} from "../services/dealabsSearch.ts";
import { predictDealHeat } from "../services/heatPrediction.ts";
import { IdealoReferenceService } from "../services/IdealoReferenceService.ts";
import { ItadService } from "../services/ItadService.ts";
import { keepaForDealPage } from "../services/keepa.ts";
import { MyDealabsPostsService } from "../services/MyDealabsPostsService.ts";
import { PriceSeriesService } from "../services/PriceSeriesService.ts";
import { PricingService } from "../services/PricingService.ts";
import { dropSameListings } from "../services/sameListing.ts";
import {
  MIN_VISIBLE_SCORE,
  ScoringService,
} from "../services/ScoringService.ts";

/**
 * A deal as the console lists it: the stored row, plus whether it is
 * already on Dealabs (the card is greyed out then).
 */
const dealResponseSchema = dealEntity.schema.extend({
  onDealabs: z
    .object({
      url: z.text({ size: "rich" }),
      price: z.number(),
      temperature: z.number(),
      mine: z.boolean(),
    })
    .optional(),
});

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
  // New = first seen, or a real price drop (see freshness.ts).
  newest: "-freshAt",
  // Most likely to reach 100° on Dealabs first (see heatPrediction.ts).
  hot: "-hotChance",
};

export class DealsController {
  protected deals = $repository(dealEntity);
  protected drafts = $repository(dealabsDraftEntity);
  protected myPosts = $inject(MyDealabsPostsService);
  protected history = $repository(priceHistoryEntity);
  protected sources = $repository(sourceEntity);
  protected pricing = $inject(PricingService);
  protected priceSeries = $inject(PriceSeriesService);
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
          .enum([
            "relevance",
            "hot",
            "discount",
            "price-asc",
            "price-desc",
            "newest",
          ])
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
      // Under MIN_VISIBLE_SCORE a deal isn't shown at all, whatever the
      // filter asks for.
      conditions.push({
        score: { gte: Math.max(minScore ?? 0, MIN_VISIBLE_SCORE) },
      });
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

      const result = await this.deals.paginate(
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
      // Colour variants of one product, listed side by side: show one.
      return {
        ...result,
        content: await this.withDealabsStatus(dropSameListings(result.content)),
      };
    },
  });

  /**
   * Marks the deals already on Dealabs: posted by us (published draft), or
   * a live deal by someone else at our price or cheaper (stored history).
   */
  protected async withDealabsStatus<
    T extends {
      id: string;
      title: string;
      currentPrice: number;
      dealabsHistory?: string | null;
    },
  >(deals: T[]): Promise<Array<T & { onDealabs?: OnDealabs }>> {
    if (deals.length === 0) return deals;
    const posted = await this.drafts.findMany({
      where: {
        and: [
          { dealId: { inArray: deals.map((deal) => deal.id) } },
          { status: { eq: "posted" } },
        ],
      },
    });
    const mine = new Map(posted.map((draft) => [draft.dealId, draft]));
    // Our live posts, from our profile: found even when the title we
    // posted differs from the merchant's.
    const ourLivePosts = (
      await this.myPosts.posts().catch(() => [] as DealabsThread[])
    ).filter((post) => !post.isExpired);
    return deals.map((deal) => {
      const ours = ourLivePosts.find((post) =>
        isSameProduct(deal.title, deal.currentPrice, post),
      );
      if (ours) {
        return {
          ...deal,
          onDealabs: {
            url: ours.url,
            price: ours.price,
            temperature: Math.round(ours.temperature),
            mine: true,
          },
        };
      }
      const draft = mine.get(deal.id);
      if (draft) {
        return {
          ...deal,
          onDealabs: {
            url: draft.dealabsUrl ?? "",
            price: deal.currentPrice,
            temperature: 0,
            mine: true,
          },
        };
      }
      let history: StoredDealabsDeal[] = [];
      try {
        history = deal.dealabsHistory ? JSON.parse(deal.dealabsHistory) : [];
      } catch {
        // Unreadable history: no status.
      }
      const live = liveOnDealabs(history, deal.currentPrice);
      return live ? { ...deal, onDealabs: live } : deal;
    });
  }

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
      const active = {
        and: [
          { status: { eq: "active" as const } },
          { score: { gte: MIN_VISIBLE_SCORE } },
        ],
      };

      const [bestDiscounts, newest, topScored] = await Promise.all([
        this.deals.findMany({
          where: { and: [...active.and, { discountPercentage: { gte: 1 } }] },
          orderBy: { column: "discountPercentage", direction: "desc" },
          limit: size * 2,
        }),
        this.deals.findMany({
          where: active,
          orderBy: { column: "freshAt", direction: "desc" },
          limit: size * 2,
        }),
        this.deals.findMany({
          where: active,
          orderBy: { column: "score", direction: "desc" },
          limit: size * 3,
        }),
      ]);

      const historicalLows: typeof topScored = [];
      for (const deal of dropSameListings(topScored)) {
        if (historicalLows.length >= size) break;
        const stats = await this.pricing.getStats(deal.id, deal.currentPrice);
        if (stats.historyPoints > 1 && stats.isNewHistoricalMin) {
          historicalLows.push(deal);
        }
      }

      const best = await this.withDealabsStatus(
        dropSameListings(bestDiscounts).slice(0, size),
      );
      const featured = best[0] ?? topScored[0];
      return {
        bestDiscounts: best,
        newest: await this.withDealabsStatus(
          dropSameListings(newest).slice(0, size),
        ),
        historicalLows: await this.withDealabsStatus(historicalLows),
        featured: featured
          ? ((await this.withDealabsStatus([featured]))[0] ?? null)
          : null,
      };
    },
  });

  /**
   * A price history from outside our collection (DekuDeals for Nintendo
   * eShop games), for the deal page's chart. `null` when no source covers
   * the product.
   */
  externalHistory = $action({
    method: "GET",
    path: "/deals/:id/external-history",
    use: [$adminSession()],
    schema: {
      params: z.object({ id: z.text() }),
      response: z
        .object({
          source: z.text(),
          url: z.text({ size: "rich" }),
          points: z.array(z.object({ at: z.text(), price: z.number() })),
        })
        .nullable(),
    },
    handler: async ({ params }) => {
      const deal = await this.deals.getById(params.id);
      const series = await this.priceSeries.seriesFor(deal);
      return series
        ? {
            source: series.source,
            url: series.url,
            points: series.points.map(([at, price]) => ({ at, price })),
          }
        : null;
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
        /**
         * Amazon product whose Keepa price chart the page shows: the deal
         * itself, or the same product found on Amazon by the cross-search.
         */
        keepa: z
          .object({ asin: z.text(), sameProductOnAmazon: z.boolean() })
          .nullable(),
        /** Chance of reaching 100° on Dealabs, with its reasons. */
        heat: z.object({
          chance: z.number(),
          label: z.enum(["froid", "tiède", "prometteur", "chaud"]),
          reasons: z.array(z.text({ size: "rich" })),
        }),
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
        heat: predictDealHeat(deal, analysis),
        keepa: keepaForDealPage(deal),
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
