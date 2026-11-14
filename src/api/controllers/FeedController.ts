import { z } from "alepha";
import { $repository } from "alepha/orm";
import { $action } from "alepha/server";

import {
  catalogOfferEntity,
  catalogPriceEntity,
} from "../entities/CatalogOffer.ts";
import { dealEntity } from "../entities/Deal.ts";
import { priceHistoryEntity } from "../entities/PriceHistory.ts";
import { sourceEntity } from "../entities/Source.ts";
import { $feedAuth } from "../services/AdminAuth.ts";
import { loadCatalogConfig } from "../services/catalogSources.ts";

const PAGE_DEFAULT = 500;
const PAGE_MAX = 1000;

const feedQuery = z.object({
  /**
   * ISO date: rows changed at or after it. Pass the previous answer's
   * `next`; rows are upserted by id, so getting the boundary rows twice
   * is harmless.
   */
  since: z.text({ maxLength: 40 }).optional(),
  /** Comma-separated source ids (« timeshop24,ocarat »). */
  sources: z.text({ maxLength: 2000 }).optional(),
  size: z.number().min(1).max(PAGE_MAX).optional(),
});

const feedPage = z.object({
  rows: z.array(z.any()),
  /** `since` of the next call. */
  next: z.text(),
  /** True when the page was full: call again right away. */
  more: z.boolean(),
});

const iso = (value: unknown) => new Date(value as string).toISOString();

/** A valid ISO `since`, or the epoch. */
export function feedSince(value?: string): string {
  const time = value ? Date.parse(value) : Number.NaN;
  return new Date(Number.isFinite(time) ? time : 0).toISOString();
}

/**
 * `next` for a page sorted by time: the last row's time — or 1 ms later
 * when a full page holds a single instant, so a caller can't loop on it.
 */
export function feedNext(
  since: string,
  times: string[],
  full: boolean,
): string {
  if (times.length === 0) return since;
  const last = times[times.length - 1];
  if (full && times[0] === last) {
    return new Date(Date.parse(last) + 1).toISOString();
  }
  return last;
}

const sourceList = (value?: string) =>
  value
    ?.split(",")
    .map((id) => id.trim())
    .filter(Boolean) ?? [];

/**
 * Read-only feed for an outside application (the watch site, `../montres`):
 * the collected offers as they are — every status and every score, which
 * the console's `GET /deals` hides under the visibility bar —, their price
 * history, and the catalogue offers (`CatalogService`). Incremental: each
 * answer gives the `since` of the next call. Guarded by `FEED_TOKEN`
 * (`$feedAuth`), which opens nothing else. Nothing here writes.
 */
export class FeedController {
  protected deals = $repository(dealEntity);
  protected history = $repository(priceHistoryEntity);
  protected sources = $repository(sourceEntity);
  protected catalog = $repository(catalogOfferEntity);
  protected catalogPrices = $repository(catalogPriceEntity);

  offers = $action({
    method: "GET",
    path: "/feed/offers",
    use: [$feedAuth()],
    schema: { query: feedQuery, response: feedPage },
    handler: async ({ query }) => {
      const since = feedSince(query.since);
      const size = query.size ?? PAGE_DEFAULT;
      const ids = sourceList(query.sources);
      const rows = await this.deals.findMany({
        where: {
          and: [
            { updatedAt: { gte: since } },
            ...(ids.length ? [{ sourceId: { inArray: ids } }] : []),
          ],
        },
        orderBy: { column: "updatedAt", direction: "asc" },
        limit: size,
      });
      const times = rows.map((row) => iso(row.updatedAt));
      return {
        rows: rows.map((deal) => ({
          id: deal.id,
          sourceId: deal.sourceId,
          externalId: deal.externalId,
          merchantId: deal.merchantId,
          title: deal.title,
          url: deal.url,
          imageUrl: deal.imageUrl,
          description: deal.description,
          price: deal.currentPrice,
          listPrice: deal.listPrice,
          listPriceKind: deal.listPriceKind,
          lowestRecentPrice: deal.lowestRecentPrice,
          currency: deal.currency,
          availability: deal.availability,
          condition: deal.condition,
          ean: deal.ean,
          sellerName: deal.sellerName,
          soldByMerchant: deal.soldByMerchant,
          productRating: deal.productRating,
          productReviewCount: deal.productReviewCount,
          shipsFrom: deal.shipsFrom,
          /** JSON of `StoredFacts`: spec table, brand, reference, warranty… */
          facts: deal.extraFacts,
          status: deal.status,
          firstSeenAt: iso(deal.firstSeenAt),
          lastSeenAt: iso(deal.lastSeenAt),
          updatedAt: iso(deal.updatedAt),
        })),
        next: feedNext(since, times, rows.length === size),
        more: rows.length === size,
      };
    },
  });

  prices = $action({
    method: "GET",
    path: "/feed/prices",
    use: [$feedAuth()],
    schema: { query: feedQuery, response: feedPage },
    handler: async ({ query }) => {
      const since = feedSince(query.since);
      const size = query.size ?? PAGE_DEFAULT;
      const ids = sourceList(query.sources);
      const rows = await this.history.findMany({
        where: { createdAt: { gte: since } },
        orderBy: { column: "createdAt", direction: "asc" },
        limit: size,
      });
      // The page is cut on the whole history, then narrowed to the asked
      // sources: `next` still advances when none of its rows are theirs.
      const wanted = ids.length
        ? new Set(
            (
              await this.deals.findMany({
                where: { sourceId: { inArray: ids } },
              })
            ).map((deal) => deal.id),
          )
        : undefined;
      const times = rows.map((row) => iso(row.createdAt));
      return {
        rows: rows
          .filter((row) => !wanted || wanted.has(row.dealId))
          .map((row) => ({
            id: row.id,
            offerId: row.dealId,
            price: row.price,
            currency: row.currency,
            observedAt: iso(row.observedAt),
          })),
        next: feedNext(since, times, rows.length === size),
        more: rows.length === size,
      };
    },
  });

  catalogOffers = $action({
    method: "GET",
    path: "/feed/catalog",
    use: [$feedAuth()],
    schema: { query: feedQuery, response: feedPage },
    handler: async ({ query }) => {
      const since = feedSince(query.since);
      const size = query.size ?? PAGE_DEFAULT;
      const ids = sourceList(query.sources);
      const rows = await this.catalog.findMany({
        where: {
          and: [
            { updatedAt: { gte: since } },
            // Pages never read or not of the wanted kind say nothing —
            // except a product read before and left out since (a kids'
            // watch): served as gone, so the other side drops it.
            {
              or: [
                { status: { inArray: ["active", "gone"] } },
                {
                  and: [
                    { status: { eq: "skipped" } },
                    { price: { isNotNull: true } },
                  ],
                },
              ],
            },
            ...(ids.length ? [{ sourceId: { inArray: ids } }] : []),
          ],
        },
        orderBy: { column: "updatedAt", direction: "asc" },
        limit: size,
      });
      const times = rows.map((row) => iso(row.updatedAt));
      return {
        rows: rows.map((row) => ({
          id: row.id,
          sourceId: row.sourceId,
          externalId: row.externalId,
          url: row.url,
          title: row.title,
          brand: row.brand,
          reference: row.reference,
          sku: row.sku,
          ean: row.ean,
          imageUrl: row.imageUrl,
          description: row.description,
          price: row.price,
          listPrice: row.listPrice,
          currency: row.currency,
          availability: row.availability,
          rating: row.rating,
          reviewCount: row.reviewCount,
          // Same shape as a deal's `extraFacts`: the page's table.
          facts: row.specs
            ? JSON.stringify({
                brand: row.brand,
                reference: row.reference,
                specs: JSON.parse(row.specs),
              })
            : undefined,
          status: row.status === "skipped" ? "gone" : row.status,
          firstSeenAt: iso(row.firstSeenAt),
          lastReadAt: row.lastReadAt ? iso(row.lastReadAt) : undefined,
          updatedAt: iso(row.updatedAt),
        })),
        next: feedNext(since, times, rows.length === size),
        more: rows.length === size,
      };
    },
  });

  catalogPriceHistory = $action({
    method: "GET",
    path: "/feed/catalog/prices",
    use: [$feedAuth()],
    schema: { query: feedQuery, response: feedPage },
    handler: async ({ query }) => {
      const since = feedSince(query.since);
      const size = query.size ?? PAGE_DEFAULT;
      const rows = await this.catalogPrices.findMany({
        where: { createdAt: { gte: since } },
        orderBy: { column: "createdAt", direction: "asc" },
        limit: size,
      });
      const times = rows.map((row) => iso(row.createdAt));
      return {
        rows: rows.map((row) => ({
          id: row.id,
          offerId: row.offerId,
          price: row.price,
          observedAt: iso(row.observedAt),
        })),
        next: feedNext(since, times, rows.length === size),
        more: rows.length === size,
      };
    },
  });

  feedSources = $action({
    method: "GET",
    path: "/feed/sources",
    use: [$feedAuth()],
    schema: {
      response: z.object({
        sources: z.array(z.any()),
        catalog: z.array(z.any()),
      }),
    },
    handler: async () => ({
      sources: (await this.sources.findMany({})).map((source) => ({
        id: source.id,
        name: source.name,
        type: source.type,
        enabled: source.enabled,
        lastSuccessAt: source.lastSuccessAt,
        lastErrorAt: source.lastErrorAt,
        lastError: source.lastError,
      })),
      catalog: loadCatalogConfig().sources.map((source) => ({
        id: source.id,
        name: source.name,
        origin: source.origin,
        reader: source.reader,
        verified: !!source.verified,
        enabled: !!source.enabled,
      })),
    }),
  });
}
