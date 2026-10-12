import { $inject } from "alepha";
import { DateTimeProvider } from "alepha/datetime";
import { $logger } from "alepha/logger";
import { $repository } from "alepha/orm";

import { modelQuery } from "../collectors/aliexpressSignals.ts";
import { readAmazonBullets } from "../collectors/AmazonCollector.ts";
import type {
  CloudflareBrowserBinding,
  DealsPage,
} from "../collectors/browser.ts";
import { parsePriceFr, withBrowser, withPage } from "../collectors/browser.ts";
import { dealEntity } from "../entities/Deal.ts";
import { type MarketComparison, matchesSameModel } from "./crossSearch.ts";
import type { Deal } from "./DealTypes.ts";

/** A market price is re-checked at most once a day per deal. */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Lookups per collection run. Each one is a search page on another
 * merchant's site — capped so a run with many new deals spreads its
 * lookups over several runs instead of hammering that site at once.
 */
const LOOKUPS_PER_RUN = 15;

/** AliExpress cross-searches per run: two searches each (Amazon, Cdiscount). */
const CROSS_SEARCHES_PER_RUN = 10;

/**
 * Below this, a deal's own description is too thin to post: borrow the
 * matched Amazon page's feature list.
 */
const MIN_OWN_DESCRIPTION = 200;

const STOPWORDS = new Set([
  "de",
  "du",
  "la",
  "le",
  "les",
  "des",
  "et",
  "en",
  "un",
  "une",
  "au",
  "aux",
  "pour",
  "avec",
  "sans",
  "the",
  "and",
  "for",
  "with",
  "of",
  "jeu",
  "edition",
  "version",
  "noir",
  "black",
  "blanc",
  "white",
]);

/**
 * Lowercased significant words of a product title. Two-character tokens
 * are kept on purpose — "FC 27", "EA", "S24" are exactly what tells two
 * products apart — and the common console spellings are normalized
 * ("PlayStation 5" and "PS5" are the same word).
 */
export function titleTokens(title: string): Set<string> {
  return new Set(
    title
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/playstation\s*(\d)/g, "ps$1")
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length >= 2 && !STOPWORDS.has(token)),
  );
}

/**
 * Do two titles describe the same product? An EAN search can still return
 * an unrelated "sponsored" item or a bundle, so the EAN alone is not taken
 * on faith: at least half of our title's significant words — and at least
 * two — must appear in the other merchant's title.
 */
export function titlesMatch(ours: string, theirs: string): boolean {
  const a = titleTokens(ours);
  const b = titleTokens(theirs);
  if (a.size === 0) return false;
  let shared = 0;
  for (const token of a) {
    if (b.has(token)) shared++;
  }
  return shared >= 2 && shared / a.size >= 0.5;
}

/**
 * Cross-merchant check: finds the very same product (matched by EAN) at
 * another merchant we can read, and records its price on the deal as
 * {@link Deal.marketPrice}. This is what tells a real deal from a price
 * that is simply the going rate everywhere — e.g. a Cdiscount "bon plan"
 * at 60,36 € that Amazon sells at 60,36 € too.
 *
 * Today the only target is Amazon.fr, whose search resolves EANs reliably
 * (measured: consoles and games matched exactly). Comparison sites were
 * evaluated first and rejected: Idealo answers 403 to any headless
 * browser, leDénicheur serves a bot challenge after two requests.
 *
 * Best effort by design: a lookup that fails or finds no credible match
 * just leaves the market price unset (scored as "not verified") and marks
 * the deal as checked, so a blocked search isn't retried every run.
 */
export class MarketReferenceService {
  protected log = $logger();
  protected dateTime = $inject(DateTimeProvider);
  protected deals = $repository(dealEntity);

  /**
   * Refreshes the market price of this source's stale deals.
   * @returns ids of the deals whose market price was (re)checked.
   */
  async refreshStale(
    sourceId: string,
    getCloudflareBinding?: () => CloudflareBrowserBinding | undefined,
    onProgress?: (done: number, total: number) => void,
  ): Promise<string[]> {
    // Amazon deals would be looked up against Amazon itself.
    if (sourceId === "amazon") {
      return [];
    }
    // AliExpress has no EAN: its branded products are matched by model.
    if (sourceId === "aliexpress") {
      return this.refreshAliExpress(getCloudflareBinding, onProgress);
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
          !!deal.ean &&
          // An EAN lookup returns *new* product prices: comparing a
          // refurbished phone to them would make every refurb look great.
          (!deal.condition || deal.condition === "new") &&
          (!deal.marketCheckedAt ||
            now - new Date(deal.marketCheckedAt).getTime() > CACHE_TTL_MS),
      )
      .slice(0, LOOKUPS_PER_RUN);

    if (stale.length === 0) {
      return [];
    }

    try {
      await withBrowser(async (browser) => {
        for (const [index, deal] of stale.entries()) {
          onProgress?.(index + 1, stale.length);
          const match = await withPage(browser, (page) =>
            this.lookupAmazon(page, deal),
          ).catch(() => undefined);
          // Cross-search: a product whose own page says little gets the
          // matched Amazon page's feature list — same EAN, same product.
          const borrowed =
            match && (deal.description?.length ?? 0) < MIN_OWN_DESCRIPTION
              ? await withPage(browser, async (page) => {
                  await page.goto(match.url, {
                    waitUntil: "domcontentloaded",
                    timeout: 20_000,
                  });
                  return readAmazonBullets(page);
                }).catch(() => undefined)
              : undefined;
          await this.deals.updateById(deal.id, {
            marketPrice: match?.price,
            marketPriceSource: match ? "Amazon" : undefined,
            marketPriceUrl: match?.url,
            marketCheckedAt: this.dateTime.nowISOString(),
            ...(borrowed
              ? {
                  description: [
                    deal.description?.trim(),
                    `Détails (fiche Amazon du même produit) :\n${borrowed}`,
                  ]
                    .filter(Boolean)
                    .join("\n\n"),
                }
              : {}),
          });
        }
      }, getCloudflareBinding?.());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.warn(`Market price lookup failed for ${sourceId}: ${message}`);
    }

    return stale.map((deal) => deal.id);
  }

  /**
   * Cross-search for AliExpress: each branded product ("POCO X7 Pro",
   * "Chuwi Ubox") is searched by model on Amazon and Cdiscount, and every
   * credible match (see `matchesSameModel`) is kept — the deal page's
   * comparison table. The cheapest becomes the market price the score
   * compares against. No-name products are skipped: nothing to compare.
   */
  protected async refreshAliExpress(
    getCloudflareBinding?: () => CloudflareBrowserBinding | undefined,
    onProgress?: (done: number, total: number) => void,
  ): Promise<string[]> {
    const now = Date.now();
    const stale = (
      await this.deals.findMany({
        where: {
          and: [
            { sourceId: { eq: "aliexpress" } },
            { status: { eq: "active" } },
          ],
        },
      })
    )
      .filter(
        (deal) =>
          !!modelQuery(deal.title) &&
          (!deal.marketCheckedAt ||
            now - new Date(deal.marketCheckedAt).getTime() > CACHE_TTL_MS),
      )
      .slice(0, CROSS_SEARCHES_PER_RUN);
    if (stale.length === 0) {
      return [];
    }

    try {
      await withBrowser(async (browser) => {
        for (const [index, deal] of stale.entries()) {
          onProgress?.(index + 1, stale.length);
          const model = modelQuery(deal.title) as string;
          const searches: Array<
            [string, (page: DealsPage) => Promise<SearchResult[]>]
          > = [
            ["Amazon", (page) => searchAmazon(page, model)],
            ["Cdiscount", (page) => searchCdiscount(page, model)],
          ];
          const found: MarketComparison[] = [];
          for (const [merchant, search] of searches) {
            const results = await withPage(browser, search).catch(
              () => [] as SearchResult[],
            );
            const best = results
              .map((result) => ({
                result,
                verdict: matchesSameModel(deal.title, model, result.title),
              }))
              .filter(
                ({ result, verdict }) =>
                  verdict.match &&
                  // Far off our price: a bundle, a lot or another variant.
                  result.price >= deal.currentPrice * 0.5 &&
                  result.price <= deal.currentPrice * 3,
              )
              .sort((a, b) => a.result.price - b.result.price)[0];
            if (best) {
              found.push({
                merchant,
                title: best.result.title,
                price: best.result.price,
                url: best.result.url,
                variantUnverified: best.verdict.variantUnverified,
              });
            }
          }
          const cheapest = [...found].sort((a, b) => a.price - b.price)[0];
          await this.deals.updateById(deal.id, {
            marketPrice: cheapest?.price,
            marketPriceSource: cheapest?.merchant,
            marketPriceUrl: cheapest?.url,
            marketComparisons: found.length ? JSON.stringify(found) : "",
            marketCheckedAt: this.dateTime.nowISOString(),
          });
        }
      }, getCloudflareBinding?.());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.warn(`AliExpress cross-search failed: ${message}`);
    }
    return stale.map((deal) => deal.id);
  }

  protected async lookupAmazon(
    page: DealsPage,
    deal: Deal,
  ): Promise<{ price: number; url: string } | undefined> {
    for (const result of await searchAmazon(page, deal.ean as string)) {
      if (!titlesMatch(deal.title, result.title)) continue;
      // A price wildly off ours is a bundle, an accessory or a lot — not
      // the same item.
      if (
        result.price < deal.currentPrice * 0.4 ||
        result.price > deal.currentPrice * 2.5
      ) {
        continue;
      }
      return { price: result.price, url: result.url };
    }
    return undefined;
  }
}

export interface SearchResult {
  title: string;
  price: number;
  url: string;
}

/** Amazon.fr search results: first non-sponsored hits with a price. */
export async function searchAmazon(
  page: DealsPage,
  query: string,
): Promise<SearchResult[]> {
  const response = await page.goto(
    `https://www.amazon.fr/s?k=${encodeURIComponent(query)}`,
    { waitUntil: "domcontentloaded", timeout: 20_000 },
  );
  if (!response || response.status() >= 400) {
    return [];
  }
  await page
    .waitForSelector('[data-component-type="s-search-result"]', {
      timeout: 8_000,
    })
    .catch(() => {
      // No results rendered: the evaluate() below finds none.
    });
  const rows = await page.evaluate(() =>
    Array.from(
      document.querySelectorAll('[data-component-type="s-search-result"]'),
    )
      .slice(0, 8)
      .map((el) => ({
        asin: el.getAttribute("data-asin"),
        sponsored: /Sponsoris/i.test((el as HTMLElement).innerText ?? ""),
        title: el.querySelector("h2")?.textContent?.trim() ?? "",
        priceText:
          el.querySelector(".a-price .a-offscreen")?.textContent?.trim() ??
          null,
      })),
  );
  return rows.flatMap((row) => {
    const price = row.priceText ? parsePriceFr(row.priceText) : undefined;
    return !row.sponsored && row.asin && price !== undefined
      ? [
          {
            title: row.title,
            price,
            url: `https://www.amazon.fr/dp/${row.asin}`,
          },
        ]
      : [];
  });
}

/** Cdiscount search results (same offer cards as its listings). */
export async function searchCdiscount(
  page: DealsPage,
  query: string,
): Promise<SearchResult[]> {
  const slug = query.split(/\s+/).map(encodeURIComponent).join("+");
  const response = await page.goto(
    `https://www.cdiscount.com/search/10/${slug}.html`,
    { waitUntil: "domcontentloaded", timeout: 20_000 },
  );
  if (!response || response.status() >= 400) {
    return [];
  }
  await page
    .waitForSelector('[data-e2e="offer-item"]', { timeout: 10_000 })
    .catch(() => {
      // No results rendered: the evaluate() below finds none.
    });
  const rows = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-e2e="offer-item"]'))
      .slice(0, 12)
      .map((el) => ({
        url: (el.closest("a") as HTMLAnchorElement | null)?.href ?? "",
        sponsored: /Sponsoris/i.test((el as HTMLElement).innerText ?? ""),
        title:
          el.querySelector('[data-e2e="lplr-title"]')?.textContent?.trim() ??
          "",
        priceText:
          el.querySelector('[data-e2e="lplr-price"]')?.textContent?.trim() ??
          null,
      })),
  );
  return rows.flatMap((row) => {
    const price = row.priceText ? parsePriceFr(row.priceText) : undefined;
    return !row.sponsored && row.url && price !== undefined
      ? [{ title: row.title, price, url: row.url.split("?")[0] }]
      : [];
  });
}
