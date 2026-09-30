import type { CloudflareBrowserBinding, DealsPage } from "./browser.ts";
import { parsePriceFr, withBrowser, withPage } from "./browser.ts";
import type { DealSource, RawDeal } from "./DealSource.ts";

/**
 * Amazon buybox price elements in priority order. There is no single
 * stable container: the id/class used depends on the product's template
 * (plain item, bundle/"lot", Amazon device, book...), so every known
 * variant is tried in turn and the first non-empty match wins.
 */
const PRICE_SELECTORS = [
  ".priceToPay .a-offscreen",
  ".apex-pricetopay-value .a-offscreen",
  "#corePrice_feature_div .a-price .a-offscreen",
  "#corePriceDisplay_desktop_feature_div .a-price .a-offscreen",
  "#apex_desktop .a-price .a-offscreen",
  "#apex_price .a-offscreen",
];

/**
 * Auto-discovers current Amazon.fr deals via a headless-browser visit to
 * `/deals` (a client-rendered SPA — plain `fetch()` sees no data at all).
 * The listing itself doesn't expose a final price in its markup, only a
 * discount percentage, so each candidate's product page is opened in turn
 * to read its real price. Kept to a small `limit` per run: every extra
 * product page is another request that can trip Amazon's bot detection.
 */
export class AmazonCollector implements DealSource {
  id = "amazon";
  name = "Amazon (bons plans, auto)";

  constructor(
    protected dealsUrl: string,
    protected limit = 6,
    /**
     * Resolves the Workers "Browser Rendering" binding, only truthy when
     * running on Cloudflare — see `CollectionService`. A getter, not a
     * plain value: `CollectionService` is a long-lived singleton reused
     * across many invocations in the same Worker isolate, so the binding
     * must be looked up fresh on every `discover()` call, not baked in at
     * construction time (it would otherwise permanently capture whatever
     * was in scope the one time this collector got constructed — often
     * `undefined`, before any request had bound `env`). Undefined
     * everywhere else, which makes `withBrowser` fall back to a local
     * Playwright Chromium.
     */
    protected getCloudflareBinding?: () => CloudflareBrowserBinding | undefined,
  ) {}

  async discover(): Promise<RawDeal[]> {
    return withBrowser(async (browser) => {
      const cards = await withPage(browser, async (page) => {
        const response = await page.goto(this.dealsUrl, {
          waitUntil: "domcontentloaded",
          timeout: 20_000,
        });
        if (!response || !response.ok()) {
          throw new Error(
            `Amazon deals page returned ${response?.status() ?? "no response"}`,
          );
        }

        await page
          .waitForSelector('[data-testid="product-card"]', {
            timeout: 10_000,
          })
          .catch(() => {
            // No card showed up in time: the evaluate() below just finds
            // none, and this run reports 0 deals rather than throwing.
          });

        return page.evaluate(() =>
          Array.from(
            document.querySelectorAll('[data-testid="product-card"]'),
          ).map((el) => {
            const link = el.querySelector(
              'a[data-testid="product-card-link"]',
            ) as HTMLAnchorElement | null;
            const img = el.querySelector("img") as HTMLImageElement | null;
            return {
              asin: el.getAttribute("data-asin"),
              url: link?.href ?? null,
              title: img?.alt || null,
              imageUrl: img?.src || null,
            };
          }),
        );
      });

      const deals: RawDeal[] = [];
      for (const card of cards.slice(0, this.limit)) {
        if (!card.asin || !card.url || !card.title) {
          continue;
        }

        try {
          // Each product page is fetched in its own browser context: Amazon
          // fingerprints sessions, and reusing cookies/context across
          // several sequential product-page loads causes later ones to
          // come back with the price element silently missing.
          const price = await withPage(browser, (page) =>
            this.fetchPrice(page, card.url as string),
          );
          if (price === undefined) {
            continue;
          }

          deals.push({
            externalId: card.asin,
            title: card.title,
            url: card.url.split("?")[0],
            imageUrl: card.imageUrl ?? undefined,
            price,
            currency: "EUR",
            availability: "in_stock",
          });
        } catch {
          // One product page failing (challenge, layout change, timeout)
          // must not block the rest of the deals found this run.
        }
      }

      return deals;
    }, this.getCloudflareBinding?.());
  }

  protected async fetchPrice(
    page: DealsPage,
    url: string,
  ): Promise<number | undefined> {
    const response = await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 15_000,
    });
    if (!response || !response.ok()) {
      return undefined;
    }

    await page
      .waitForSelector(PRICE_SELECTORS.join(", "), { timeout: 8_000 })
      .catch(() => {
        // No price container showed up: the evaluate() below returns
        // undefined and this candidate is simply skipped.
      });

    const priceText = await page.evaluate((selectors) => {
      for (const selector of selectors) {
        for (const el of Array.from(document.querySelectorAll(selector))) {
          const text = el.textContent?.trim();
          if (text) {
            return text;
          }
        }
      }
      return null;
    }, PRICE_SELECTORS);

    if (!priceText) {
      return undefined;
    }

    return parsePriceFr(priceText);
  }
}
