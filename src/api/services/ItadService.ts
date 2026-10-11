import { $env, $inject, z } from "alepha";
import { DateTimeProvider } from "alepha/datetime";
import { $logger } from "alepha/logger";
import { $repository } from "alepha/orm";

import { dealEntity } from "../entities/Deal.ts";

const API = "https://api.isthereanydeal.com";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
/** ITAD allows 1000 requests / 5 min; each game costs 2 (lookup + overview). */
const GAMES_PER_RUN = 60;

/** One point of a game's price history on Steam. */
export interface ItadHistoryPoint {
  date: string;
  price: number;
  regular?: number;
}

/**
 * IsThereAnyDeal (https://docs.isthereanydeal.com/): for PC games, the
 * all-time low across stores and the full price history, in EUR for
 * France — the price-history service Steam itself doesn't offer.
 *
 * Needs a free API key (register an app at
 * https://isthereanydeal.com/apps/my/) in `ITAD_API_KEY`. Without one,
 * everything here is a no-op and Steam deals are scored without a
 * historical low, as before.
 *
 * Response shapes follow ITAD's published OpenAPI spec; they could not be
 * exercised against live data without a key, so every field is read
 * defensively and an unexpected shape just means "no data".
 */
export class ItadService {
  protected log = $logger();
  protected dateTime = $inject(DateTimeProvider);
  protected deals = $repository(dealEntity);
  protected env = $env(
    z.object({
      ITAD_API_KEY: z.text().optional(),
    }),
  );

  get enabled(): boolean {
    return !!this.env.ITAD_API_KEY;
  }

  /**
   * Stores, for this source's stale Steam deals: the all-time low (price,
   * date) and, when another store sells the game cheaper right now, that
   * store's price as the cross-merchant market price.
   * @returns ids of the deals that were checked.
   */
  async refreshStale(
    sourceId: string,
    onProgress?: (done: number, total: number) => void,
  ): Promise<string[]> {
    if (!this.enabled || sourceId !== "steam") {
      return [];
    }
    const candidates = await this.deals.findMany({
      where: {
        and: [{ sourceId: { eq: sourceId } }, { status: { eq: "active" } }],
      },
    });
    const now = Date.now();
    const stale = candidates
      .filter(
        (deal) =>
          !deal.itadCheckedAt ||
          now - new Date(deal.itadCheckedAt).getTime() > CACHE_TTL_MS,
      )
      .slice(0, GAMES_PER_RUN);

    for (const [index, deal] of stale.entries()) {
      onProgress?.(index + 1, stale.length);
      try {
        const itadId = deal.itadId ?? (await this.lookup(deal.externalId));
        const overview = itadId ? await this.overview(itadId) : undefined;
        const cheaperElsewhere =
          overview?.current &&
          !/steam/i.test(overview.current.shop) &&
          overview.current.price < deal.currentPrice
            ? overview.current
            : undefined;
        await this.deals.updateById(deal.id, {
          itadId,
          historicalLowPrice: overview?.lowest?.price,
          historicalLowAt: overview?.lowest?.at,
          historicalLowSource: overview?.lowest
            ? `IsThereAnyDeal (${overview.lowest.shop})`
            : undefined,
          ...(cheaperElsewhere
            ? {
                marketPrice: cheaperElsewhere.price,
                marketPriceSource: cheaperElsewhere.shop,
                marketPriceUrl: cheaperElsewhere.url,
                marketCheckedAt: this.dateTime.nowISOString(),
              }
            : {}),
          itadCheckedAt: this.dateTime.nowISOString(),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.log.warn(`ITAD lookup failed for "${deal.title}": ${message}`);
      }
    }
    return stale.map((deal) => deal.id);
  }

  /** Steam price history (shop 61), oldest first. On demand, not cached. */
  async history(itadId: string): Promise<ItadHistoryPoint[]> {
    if (!this.enabled) {
      return [];
    }
    const since = new Date(
      Date.now() - 2 * 365 * 24 * 3600 * 1000,
    ).toISOString();
    const rows = (await this.get(
      `/games/history/v2?id=${itadId}&country=FR&shops=61&since=${encodeURIComponent(since)}`,
    )) as
      | Array<{
          timestamp?: string;
          deal?: { price?: { amount?: number }; regular?: { amount?: number } };
        }>
      | undefined;
    return (Array.isArray(rows) ? rows : [])
      .filter(
        (row) => row.timestamp && typeof row.deal?.price?.amount === "number",
      )
      .map((row) => ({
        date: row.timestamp as string,
        price: row.deal?.price?.amount as number,
        regular: row.deal?.regular?.amount,
      }))
      .sort((a, b) => a.date.localeCompare(b.date));
  }

  protected async lookup(appId: string): Promise<string | undefined> {
    const json = (await this.get(`/games/lookup/v1?appid=${appId}`)) as
      | { found?: boolean; game?: { id?: string } }
      | undefined;
    return json?.found ? json.game?.id : undefined;
  }

  protected async overview(itadId: string): Promise<
    | {
        current?: { shop: string; price: number; url?: string };
        lowest?: { shop: string; price: number; at?: string };
      }
    | undefined
  > {
    const json = (await this.post("/games/overview/v2?country=FR", [
      itadId,
    ])) as
      | {
          prices?: Array<{
            current?: {
              shop?: { name?: string };
              price?: { amount?: number };
              url?: string;
            };
            lowest?: {
              shop?: { name?: string };
              price?: { amount?: number };
              timestamp?: string;
            };
          }>;
        }
      | undefined;
    const entry = json?.prices?.[0];
    if (!entry) {
      return undefined;
    }
    return {
      current:
        typeof entry.current?.price?.amount === "number"
          ? {
              shop: entry.current.shop?.name ?? "?",
              price: entry.current.price.amount,
              url: entry.current.url,
            }
          : undefined,
      lowest:
        typeof entry.lowest?.price?.amount === "number"
          ? {
              shop: entry.lowest.shop?.name ?? "?",
              price: entry.lowest.price.amount,
              at: entry.lowest.timestamp,
            }
          : undefined,
    };
  }

  protected async get(path: string): Promise<unknown> {
    const separator = path.includes("?") ? "&" : "?";
    const response = await fetch(
      `${API}${path}${separator}key=${this.env.ITAD_API_KEY}`,
    );
    return response.ok ? response.json() : undefined;
  }

  protected async post(path: string, body: unknown): Promise<unknown> {
    const separator = path.includes("?") ? "&" : "?";
    const response = await fetch(
      `${API}${path}${separator}key=${this.env.ITAD_API_KEY}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    return response.ok ? response.json() : undefined;
  }
}
