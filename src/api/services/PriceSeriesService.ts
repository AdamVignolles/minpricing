import { $inject } from "alepha";
import { $cache } from "alepha/cache";
import { DateTimeProvider } from "alepha/datetime";
import { $logger } from "alepha/logger";
import { $repository } from "alepha/orm";

import { dealEntity } from "../entities/Deal.ts";
import {
  nintendoGameName,
  parseDekuHistory,
  pickDekuItem,
  type PriceSeries,
  seriesChartConfig,
  seriesLow,
} from "./priceSeries.ts";

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept-Language": "fr-FR,fr;q=0.9",
};

/** History lookups per collection run (two requests each), spaced out. */
const LOOKUPS_PER_RUN = 20;
const SPACING_MS = 1_200;

/**
 * Price histories for deals Keepa can't chart. Nintendo eShop games:
 * DekuDeals keeps every day's French eShop price since release, in the
 * page itself (`price_history_data`). Cached 24 h per deal; the all-time
 * low (last two years) is stored on the deal so the score's "Historique"
 * criterion uses it.
 */
export class PriceSeriesService {
  protected log = $logger();
  protected dateTime = $inject(DateTimeProvider);
  protected deals = $repository(dealEntity);
  protected cache = $cache<PriceSeries | { none: true }>({
    name: "price-series",
    ttl: [24, "hours"],
  });
  protected charts = $cache<{ url: string }>({
    name: "price-series-chart",
    ttl: [24, "hours"],
  });
  protected lastRequest = 0;

  /** The deal's external price history, if a source covers it. */
  async seriesFor(deal: {
    id: string;
    sourceId: string;
    title: string;
  }): Promise<PriceSeries | undefined> {
    if (deal.sourceId !== "nintendo") return undefined;
    const cached = await this.cache.get(deal.id).catch(() => undefined);
    if (cached) return "none" in cached ? undefined : cached;

    const series = await this.fetchDeku(deal.title).catch((error) => {
      this.log.warn("DekuDeals lookup failed", {
        title: deal.title,
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    });
    await this.cache
      .set(deal.id, series ?? { none: true })
      .catch(() => undefined);
    return series;
  }

  /**
   * After a Nintendo run: the all-time low (two years) of the deals not
   * checked in the last 24 h, stored as `historicalLow*`.
   * @returns ids of the deals updated (to rescore).
   */
  async refreshLows(sourceId: string): Promise<string[]> {
    if (sourceId !== "nintendo") return [];
    const deals = await this.deals.findMany({
      where: {
        and: [{ sourceId: { eq: sourceId } }, { status: { eq: "active" } }],
      },
    });
    const updated: string[] = [];
    let lookups = 0;
    for (const deal of deals) {
      if (lookups >= LOOKUPS_PER_RUN) break;
      const fresh = await this.cache.get(deal.id).catch(() => undefined);
      if (fresh) continue;
      lookups++;
      const series = await this.seriesFor(deal);
      const since = new Date(
        new Date(this.dateTime.nowISOString()).getTime() - 730 * 86_400_000,
      )
        .toISOString()
        .slice(0, 10);
      const low = series ? seriesLow(series.points, since) : undefined;
      if (low) {
        await this.deals.updateById(deal.id, {
          historicalLowPrice: low.price,
          historicalLowAt: new Date(low.at).toISOString(),
          historicalLowSource: "Nintendo eShop, via DekuDeals",
        });
        updated.push(deal.id);
      }
    }
    return updated;
  }

  /**
   * A PNG of the last year (QuickChart renders the Chart.js config and
   * gives a short URL), for the top of a Dealabs description. Dealabs
   * re-hosts the image, so the URL only has to live until then.
   */
  async chartImageUrl(deal: {
    id: string;
    sourceId: string;
    title: string;
  }): Promise<string | undefined> {
    const series = await this.seriesFor(deal);
    if (!series || series.points.length < 2) return undefined;
    const cached = await this.charts.get(deal.id).catch(() => undefined);
    if (cached) return cached.url;
    const today = this.dateTime.nowISOString().slice(0, 10);
    const response = await fetch("https://quickchart.io/chart/create", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chart: seriesChartConfig(series, nintendoGameName(deal.title), today),
        version: "4",
        width: 800,
        height: 300,
        backgroundColor: "white",
        format: "png",
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const json = (await response.json().catch(() => ({}))) as { url?: string };
    if (!response.ok || !json.url) return undefined;
    await this.charts.set(deal.id, { url: json.url }).catch(() => undefined);
    return json.url;
  }

  protected async fetchDeku(title: string): Promise<PriceSeries | undefined> {
    const name = nintendoGameName(title);
    const search = await this.get(
      `https://www.dekudeals.com/search?q=${encodeURIComponent(name)}&country=fr`,
    );
    const slug = pickDekuItem(search, title);
    if (!slug) return undefined;
    const url = `https://www.dekudeals.com/items/${slug}?country=fr`;
    const points = parseDekuHistory(
      await this.get(url),
      /switch 2/i.test(title),
    );
    return points.length
      ? { source: "Nintendo eShop, via DekuDeals", url, points }
      : undefined;
  }

  /** Paced: one request to DekuDeals at a time, 1.2 s apart. */
  protected async get(url: string): Promise<string> {
    const wait = this.lastRequest + SPACING_MS - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    this.lastRequest = Date.now();
    const response = await fetch(url, {
      headers: HEADERS,
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`${url} returned ${response.status}`);
    return response.text();
  }
}
