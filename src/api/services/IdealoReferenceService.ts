import { $inject } from "alepha";
import { DateTimeProvider } from "alepha/datetime";
import { $logger } from "alepha/logger";
import { $repository } from "alepha/orm";

import type { CloudflareBrowserBinding } from "../collectors/browser.ts";
import { withBrowser, withPage } from "../collectors/browser.ts";
import type { TrackedProduct } from "../collectors/DealSource.ts";
import { trackedProductEntity } from "../entities/TrackedProduct.ts";

/**
 * How long a successfully-scraped {@link TrackedProduct.idealoReferencePrice}
 * is trusted before being refreshed. Idealo is a price-comparison site, not
 * the merchant itself — its "best price across merchants" moves far slower
 * than our own tracked offer, so there is no value in re-scraping it on
 * every 30-minute collection tick, only in eating into Idealo's (aggressive,
 * see below) bot protection budget for nothing.
 */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Fetches, for a {@link TrackedProduct} that has an `idealoUrl` configured,
 * the lowest price Idealo currently lists across all merchants for that
 * product — used purely as an external "market reference price" so
 * {@link ScoringService} can tell a deal that beats the wider market from
 * one that only beats our own (thin) price history.
 *
 * Idealo is NOT treated as a `DealSource`/collector on purpose: it never
 * produces a deal of its own (no merchant, no checkout), it only enriches
 * the scoring of deals collected elsewhere. It also fronts noticeably
 * aggressive bot protection (an Akamai/DataDome-style challenge page, a
 * plain 403 even from a real headless browser in some environments) — so
 * every call here degrades to the last cached price, or `undefined`,
 * rather than ever throwing or blocking a collection run.
 */
export class IdealoReferenceService {
  protected log = $logger();
  protected dateTime = $inject(DateTimeProvider);
  protected products = $repository(trackedProductEntity);

  /**
   * @returns the best price to use as reference right now (freshly scraped
   * or cached), or `undefined` if the product has no `idealoUrl` and
   * nothing was ever cached.
   */
  async getReferencePrice(
    product: TrackedProduct,
    getCloudflareBinding?: () => CloudflareBrowserBinding | undefined,
  ): Promise<number | undefined> {
    if (!product.idealoUrl) {
      return undefined;
    }

    const checkedAt = product.idealoCheckedAt
      ? new Date(product.idealoCheckedAt).getTime()
      : 0;
    const age = Date.now() - checkedAt;
    if (age < CACHE_TTL_MS) {
      return product.idealoReferencePrice;
    }

    try {
      const price = await withBrowser(
        (browser) =>
          withPage(browser, (page) =>
            scrapeIdealoPrice(page, product.idealoUrl as string),
          ),
        getCloudflareBinding?.(),
      );

      await this.products.updateById(product.id, {
        idealoReferencePrice: price ?? product.idealoReferencePrice,
        idealoCheckedAt: this.dateTime.nowISOString(),
      });

      return price ?? product.idealoReferencePrice;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.warn(
        `Idealo reference price scrape failed for "${product.title}": ${message}`,
      );
      // Still mark it as checked: a page that is currently blocking us will
      // very likely still be blocking us in 30 minutes, and we don't want
      // to retry every single run until the TTL passes.
      await this.products.updateById(product.id, {
        idealoCheckedAt: this.dateTime.nowISOString(),
      });
      return product.idealoReferencePrice;
    }
  }

  /**
   * Scrapes Idealo's own "évolution du prix" chart — the actual
   * price-over-time series it draws for a product, not just today's lowest
   * price. Unlike {@link getReferencePrice} this is never cached: it is
   * only called on demand, when a user opens a deal that has an
   * `idealoUrl`, so there is no collection-run budget to protect.
   *
   * Best-effort and intentionally defensive: Idealo's bot protection has
   * returned a bare 403 (no markup, no chart data, nothing to parse) in
   * every environment this was tested from, so the chart's actual HTML/JS
   * shape could not be inspected while writing this. `scrapeIdealoHistory`
   * therefore tries several *generic* strategies (common SSR state globals,
   * then a structural scan for anything shaped like a date/price series)
   * rather than a single hand-tuned selector, and returns `undefined` the
   * moment every strategy comes up empty — never throws, never fabricates
   * points. Revisit the extraction strategies in `scrapeIdealoHistory` if
   * this keeps returning nothing from an environment that isn't blocked.
   */
  async getPriceHistory(
    url: string,
    getCloudflareBinding?: () => CloudflareBrowserBinding | undefined,
  ): Promise<IdealoHistoryPoint[] | undefined> {
    try {
      const points = await withBrowser(
        (browser) =>
          withPage(browser, (page) => scrapeIdealoHistory(page, url)),
        getCloudflareBinding?.(),
      );
      return points && points.length > 0 ? points : undefined;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.warn(
        `Idealo price-history scrape failed for "${url}": ${message}`,
      );
      return undefined;
    }
  }
}

interface IdealoPage {
  goto(
    url: string,
    options: { waitUntil: "domcontentloaded"; timeout: number },
  ): Promise<{ ok(): boolean; status(): number } | null>;
  evaluate<T>(fn: () => T): Promise<T>;
}

/** One point of Idealo's own "price development" chart. */
export interface IdealoHistoryPoint {
  /** ISO date (day precision — Idealo's chart is daily, not timestamped). */
  date: string;
  price: number;
}

async function scrapeIdealoPrice(
  page: IdealoPage,
  url: string,
): Promise<number | undefined> {
  const response = await page.goto(url, {
    waitUntil: "domcontentloaded",
    timeout: 20_000,
  });
  if (!response || !response.ok()) {
    return undefined;
  }

  // Idealo embeds a schema.org `Product`/`AggregateOffer` JSON-LD block with
  // a `lowPrice`, same as most comparison sites — read that first since it
  // is far more stable across redesigns than any CSS selector.
  const jsonLdPrice = await page.evaluate(() => {
    const scripts = Array.from(
      document.querySelectorAll('script[type="application/ld+json"]'),
    );
    for (const script of scripts) {
      try {
        const json = JSON.parse(script.textContent ?? "null");
        const candidates = Array.isArray(json) ? json : [json];
        for (const entry of candidates) {
          const offers = entry?.offers;
          const price = offers?.lowPrice ?? offers?.price;
          if (price) {
            return Number(price);
          }
        }
      } catch {
        // Not valid/matching JSON-LD: try the next script tag.
      }
    }
    return null;
  });

  if (jsonLdPrice && Number.isFinite(jsonLdPrice)) {
    return jsonLdPrice;
  }

  // Fallback: the page's own "meilleur prix" headline price element.
  const selectorPrice = await page.evaluate(() => {
    const el = document.querySelector(
      '[data-testid="offerPrice"], [data-test="priceInfo-price"], .oopStage-price',
    );
    const text = el?.textContent?.trim();
    if (!text) {
      return null;
    }
    const match = text.replace(/\s/g, "").match(/(\d+(?:[.,]\d{1,2})?)/);
    return match ? Number(match[1].replace(",", ".")) : null;
  });

  return selectorPrice && Number.isFinite(selectorPrice)
    ? selectorPrice
    : undefined;
}

/**
 * Best-effort extraction of Idealo's "évolution du prix" chart series. See
 * {@link IdealoReferenceService.getPriceHistory} for why this is layered
 * rather than a single selector: the real markup could not be inspected
 * (hard 403 in every test environment), so this leans on patterns common
 * to most server-rendered comparison/e-commerce sites instead of anything
 * Idealo-specific that was actually observed.
 */
async function scrapeIdealoHistory(
  page: IdealoPage,
  url: string,
): Promise<IdealoHistoryPoint[] | undefined> {
  const response = await page.goto(url, {
    waitUntil: "domcontentloaded",
    timeout: 20_000,
  });
  if (!response || !response.ok()) {
    return undefined;
  }

  return page.evaluate(() => {
    /**
     * Recognizable date/price-series shape: an array of objects each
     * carrying one date-like key and one numeric price-like key.
     * `candidateKeys` covers the field names most SSR state blobs and
     * charting libraries (Highcharts/Recharts/Chart.js JSON configs) use.
     */
    const DATE_KEYS = ["date", "day", "time", "timestamp", "x", "label"];
    const PRICE_KEYS = ["price", "value", "y", "amount", "lowPrice"];

    function asIsoDate(raw: unknown): string | undefined {
      if (typeof raw === "number") {
        // Epoch seconds vs milliseconds: anything under ~3e10 is almost
        // certainly seconds (year ~2920 in ms, year ~1970 in s).
        const ms = raw < 3e10 ? raw * 1000 : raw;
        const d = new Date(ms);
        return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
      }
      if (typeof raw === "string") {
        const d = new Date(raw);
        return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
      }
      return undefined;
    }

    function asPrice(raw: unknown): number | undefined {
      if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
        return raw;
      }
      if (typeof raw === "string") {
        const n = Number(raw.replace(",", "."));
        return Number.isFinite(n) && n > 0 ? n : undefined;
      }
      return undefined;
    }

    function asSeries(
      value: unknown,
    ): Array<{ date: string; price: number }> | undefined {
      if (!Array.isArray(value) || value.length < 2) {
        return undefined;
      }
      const points: Array<{ date: string; price: number }> = [];
      for (const entry of value) {
        if (!entry || typeof entry !== "object") {
          return undefined;
        }
        const record = entry as Record<string, unknown>;
        const dateKey = DATE_KEYS.find((key) => key in record);
        const priceKey = PRICE_KEYS.find((key) => key in record);
        if (!dateKey || !priceKey) {
          return undefined;
        }
        const date = asIsoDate(record[dateKey]);
        const price = asPrice(record[priceKey]);
        if (!date || !price) {
          return undefined;
        }
        points.push({ date, price });
      }
      return points.length >= 2 ? points : undefined;
    }

    /** Depth-first search through a parsed JSON blob for the first array
     * matching {@link asSeries}'s shape. Depth-limited: these SSR state
     * blobs can be deeply nested, but a real price-history array is never
     * more than a handful of levels down from the root. */
    function findSeries(
      value: unknown,
      depth: number,
      seen: Set<unknown>,
    ): Array<{ date: string; price: number }> | undefined {
      if (depth > 8 || !value || typeof value !== "object") {
        return undefined;
      }
      if (seen.has(value)) {
        return undefined;
      }
      seen.add(value);

      const series = asSeries(value);
      if (series) {
        return series;
      }

      const children = Array.isArray(value)
        ? value
        : Object.values(value as Record<string, unknown>);
      for (const child of children) {
        const found = findSeries(child, depth + 1, seen);
        if (found) {
          return found;
        }
      }
      return undefined;
    }

    // Strategy 1: common SSR state globals most frameworks expose on
    // `window` for hydration (Next.js, Nuxt, a hand-rolled Redux/Apollo
    // bootstrap). Cheap to check, no parsing required.
    const globals = [
      "__NEXT_DATA__",
      "__NUXT__",
      "__INITIAL_STATE__",
      "__APOLLO_STATE__",
      "__PRELOADED_STATE__",
    ] as const;
    for (const name of globals) {
      const value = (window as unknown as Record<string, unknown>)[name];
      if (value) {
        const found = findSeries(value, 0, new Set());
        if (found) {
          return found;
        }
      }
    }

    // Strategy 2: any inline <script> whose text content parses as JSON
    // (ld+json or a plain data blob) and contains a matching series
    // somewhere inside it.
    const scripts = Array.from(document.querySelectorAll("script"));
    for (const script of scripts) {
      const text = script.textContent?.trim();
      if (!text || !(text.startsWith("{") || text.startsWith("["))) {
        continue;
      }
      try {
        const json = JSON.parse(text);
        const found = findSeries(json, 0, new Set());
        if (found) {
          return found;
        }
      } catch {
        // Not JSON, or JSON that doesn't contain a matching series: try
        // the next script tag.
      }
    }

    // Strategy 3: a dedicated chart container exposing its own data via a
    // `data-*` attribute (a pattern some comparison sites use to hand
    // server-rendered data to a client-side charting widget without a
    // full state blob).
    const chartHost = document.querySelector(
      '[data-testid*="price"], [data-testid*="chart"], [class*="priceChart"], [class*="price-history"]',
    );
    for (const attr of Array.from(chartHost?.attributes ?? [])) {
      if (!attr.value.trim().startsWith("[")) {
        continue;
      }
      try {
        const found = asSeries(JSON.parse(attr.value));
        if (found) {
          return found;
        }
      } catch {
        // Not a JSON array: not this attribute.
      }
    }

    return undefined;
  });
}
