import { z } from "alepha";
import { $repository } from "alepha/orm";
import { $action } from "alepha/server";

import { categoryEntity } from "../entities/Category.ts";
import { dealEntity } from "../entities/Deal.ts";
import { merchantEntity } from "../entities/Merchant.ts";
import { sourceEntity } from "../entities/Source.ts";
import { $adminSession } from "../services/AdminAuth.ts";

const breakdownSchema = z.array(
  z.object({
    id: z.text(),
    name: z.text(),
    count: z.number(),
    averageDiscount: z.number().nullable(),
  }),
);

/** Buckets the discount histogram and the list filters agree on. */
const DISCOUNT_BUCKETS: Array<{ label: string; min: number; max: number }> = [
  { label: "10-20 %", min: 10, max: 20 },
  { label: "20-30 %", min: 20, max: 30 },
  { label: "30-50 %", min: 30, max: 50 },
  { label: "50-70 %", min: 50, max: 70 },
  { label: "70 %+", min: 70, max: Number.POSITIVE_INFINITY },
];

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Aggregates for the dashboard and the statistics page.
 *
 * Everything here is derived from rows that actually exist: a metric with
 * no data behind it is reported as `null`/`0` rather than filled in, so
 * the UI can show an honest empty state instead of a plausible-looking
 * number.
 *
 * Aggregation runs in JS over the active deals rather than in SQL. At this
 * app's volume (a few deals a day, a few thousand rows at most) that is a
 * single indexed read, and it keeps the exact same code path working on
 * SQLite locally and D1 on Workers. Revisit if the catalogue ever grows by
 * orders of magnitude.
 */
export class StatsController {
  protected deals = $repository(dealEntity);
  protected categories = $repository(categoryEntity);
  protected merchants = $repository(merchantEntity);
  protected sources = $repository(sourceEntity);

  overview = $action({
    method: "GET",
    path: "/stats/overview",
    use: [$adminSession()],
    schema: {
      response: z.object({
        totals: z.object({
          activeDeals: z.number(),
          expiredDeals: z.number(),
          newLast24h: z.number(),
          newLast7d: z.number(),
          dealsWithDiscount: z.number(),
          /** Null while no active deal carries a real discount. */
          averageDiscount: z.number().nullable(),
          bestDiscount: z.number().nullable(),
          /** Sum of (listPrice - currentPrice) over discounted deals. */
          potentialSavings: z.number(),
          averagePrice: z.number().nullable(),
        }),
        categories: breakdownSchema,
        merchants: breakdownSchema,
        discountBuckets: z.array(
          z.object({ label: z.text(), count: z.number() }),
        ),
        dealsPerDay: z.array(z.object({ date: z.text(), count: z.number() })),
        sources: z.array(
          z.object({
            id: z.text(),
            name: z.text(),
            type: z.text(),
            enabled: z.boolean(),
            activeDeals: z.number(),
            lastRunAt: z.datetime().optional(),
            lastSuccessAt: z.datetime().optional(),
            lastErrorAt: z.datetime().optional(),
            lastError: z.text().optional(),
          }),
        ),
      }),
    },
    handler: async () => {
      const [active, expiredDeals, categories, merchants, sources] =
        await Promise.all([
          this.deals.findMany({ where: { status: { eq: "active" } } }),
          this.deals.count({ status: { eq: "expired" } }),
          this.categories.findMany(),
          this.merchants.findMany(),
          this.sources.findMany(),
        ]);

      const now = Date.now();
      const firstSeenMs = (deal: (typeof active)[number]) =>
        new Date(deal.firstSeenAt as string | number).getTime();

      const discounted = active.filter(
        (deal) => (deal.discountPercentage ?? 0) > 0,
      );

      const savings = discounted.reduce((sum, deal) => {
        const reference = deal.listPrice ?? 0;
        return reference > deal.currentPrice
          ? sum + (reference - deal.currentPrice)
          : sum;
      }, 0);

      const average = (values: number[]) =>
        values.length
          ? Math.round(
              (values.reduce((sum, value) => sum + value, 0) / values.length) *
                10,
            ) / 10
          : null;

      const breakdown = (
        key: "categoryId" | "merchantId",
        reference: Array<{ id: string; name: string }>,
      ) =>
        reference
          .map((item) => {
            const matching = active.filter((deal) => deal[key] === item.id);
            return {
              id: item.id,
              name: item.name,
              count: matching.length,
              averageDiscount: average(
                matching
                  .map((deal) => deal.discountPercentage ?? 0)
                  .filter((value) => value > 0),
              ),
            };
          })
          // A reference row with no deals is noise in a chart, not a
          // category the user can act on.
          .filter((item) => item.count > 0)
          .sort((a, b) => b.count - a.count);

      const dealsPerDay: Array<{ date: string; count: number }> = [];
      for (let offset = 29; offset >= 0; offset--) {
        const dayStart = new Date(now - offset * DAY_MS);
        dayStart.setHours(0, 0, 0, 0);
        const dayEnd = dayStart.getTime() + DAY_MS;
        dealsPerDay.push({
          date: dayStart.toISOString().slice(0, 10),
          count: active.filter((deal) => {
            const seen = firstSeenMs(deal);
            return seen >= dayStart.getTime() && seen < dayEnd;
          }).length,
        });
      }

      return {
        totals: {
          activeDeals: active.length,
          expiredDeals,
          newLast24h: active.filter((deal) => now - firstSeenMs(deal) < DAY_MS)
            .length,
          newLast7d: active.filter(
            (deal) => now - firstSeenMs(deal) < 7 * DAY_MS,
          ).length,
          dealsWithDiscount: discounted.length,
          averageDiscount: average(
            discounted.map((deal) => deal.discountPercentage ?? 0),
          ),
          bestDiscount: discounted.length
            ? Math.max(
                ...discounted.map((deal) => deal.discountPercentage ?? 0),
              )
            : null,
          potentialSavings: Math.round(savings),
          averagePrice: average(active.map((deal) => deal.currentPrice)),
        },
        categories: breakdown("categoryId", categories),
        merchants: breakdown("merchantId", merchants),
        discountBuckets: DISCOUNT_BUCKETS.map((bucket) => ({
          label: bucket.label,
          count: discounted.filter((deal) => {
            const value = deal.discountPercentage ?? 0;
            return value >= bucket.min && value < bucket.max;
          }).length,
        })),
        dealsPerDay,
        sources: sources.map((source) => ({
          id: source.id,
          name: source.name,
          type: source.type,
          enabled: source.enabled,
          activeDeals: active.filter((deal) => deal.sourceId === source.id)
            .length,
          lastRunAt: source.lastRunAt,
          lastSuccessAt: source.lastSuccessAt,
          lastErrorAt: source.lastErrorAt,
          lastError: source.lastError,
        })),
      };
    },
  });
}
