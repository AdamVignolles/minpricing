import type { CloudflareBrowserBinding, DealsPage } from "./browser.ts";
import {
  parsePriceFr,
  scrollAndCollect,
  withBrowser,
  withPage,
} from "./browser.ts";
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
 * Struck-through "prix barré" elements, in priority order. Amazon marks
 * its reference price with `.a-text-price`, but that class is also used
 * for unrelated prices on some templates, so the result is only kept when
 * it is strictly above the price actually being paid (see `fetchPrice`).
 */
const LIST_PRICE_SELECTORS = [
  ".basisPrice .a-offscreen",
  "#corePriceDisplay_desktop_feature_div .a-text-price .a-offscreen",
  "#corePrice_feature_div .a-text-price .a-offscreen",
  'span[data-a-strike="true"] .a-offscreen',
  ".a-price.a-text-price .a-offscreen",
];

/**
 * Auto-discovers current Amazon.fr deals via a headless-browser visit to
 * one or more listing pages (a client-rendered SPA — plain `fetch()` sees
 * no data at all). Supports several entry points (e.g. the generic
 * `/deals` page plus category-filtered variants or `/gp/goldbox`) so a
 * single narrow page isn't the only source of candidates — cards are
 * merged and de-duplicated by ASIN across all of them before any product
 * page is opened. The listing itself doesn't expose a final price in its
 * markup, only a discount percentage, so each candidate's product page is
 * then opened in turn to read its real price. `limit` (default 40,
 * overridable via `AMAZON_DEALS_LIMIT`) caps the total: every extra
 * product page is another request that can trip Amazon's bot detection,
 * so raise it gradually rather than jumping straight to a very large
 * number — and prefer adding more listing-page URLs first, since a wider
 * net of *candidates* costs nothing extra until they're priced.
 */
export class AmazonCollector implements DealSource {
  id = "amazon";
  name = "Amazon (bons plans, auto)";

  protected readonly dealsUrls: string[];

  constructor(
    dealsUrls: string | string[],
    protected limit = 40,
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
  ) {
    this.dealsUrls = Array.isArray(dealsUrls) ? dealsUrls : [dealsUrls];
  }

  async discover(): Promise<RawDeal[]> {
    return withBrowser(async (browser) => {
      const cardsByAsin = new Map<
        string,
        { asin: string; url: string; title: string; imageUrl: string | null }
      >();

      for (const dealsUrl of this.dealsUrls) {
        try {
          const cards = await withPage(browser, async (page) => {
            const response = await page.goto(dealsUrl, {
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
                // No card showed up in time: the extract() below just
                // finds none, and this URL simply contributes 0 cards.
              });

            // Collected across every scroll step, not read once at the
            // end: see `scrollAndCollect`'s doc — Amazon's grid is
            // virtualized, so a single read only ever sees whichever
            // batch happened to be mounted at the final scroll position.
            return scrollAndCollect(
              page,
              () =>
                page.evaluate(() =>
                  Array.from(
                    document.querySelectorAll('[data-testid="product-card"]'),
                  ).map((el) => {
                    const link = el.querySelector(
                      'a[data-testid="product-card-link"]',
                    ) as HTMLAnchorElement | null;
                    const img = el.querySelector(
                      "img",
                    ) as HTMLImageElement | null;
                    return {
                      asin: el.getAttribute("data-asin"),
                      url: link?.href ?? null,
                      title: img?.alt || null,
                      imageUrl: img?.src || null,
                    };
                  }),
                ),
              (card) => card.asin,
            );
          });

          for (const card of cards) {
            if (
              card.asin &&
              card.url &&
              card.title &&
              !cardsByAsin.has(card.asin)
            ) {
              cardsByAsin.set(card.asin, {
                asin: card.asin,
                url: card.url,
                title: card.title,
                imageUrl: card.imageUrl,
              });
            }
          }
        } catch {
          // One listing page failing (challenge, layout change, timeout)
          // must not block the other entry points from contributing cards.
        }
      }

      const deals: RawDeal[] = [];
      for (const card of Array.from(cardsByAsin.values()).slice(
        0,
        this.limit,
      )) {
        try {
          // Each product page is fetched in its own browser context: Amazon
          // fingerprints sessions, and reusing cookies/context across
          // several sequential product-page loads causes later ones to
          // come back with the price element silently missing.
          const priced = await withPage(browser, (page) =>
            this.fetchPrice(page, card.url),
          );
          if (!priced) {
            continue;
          }

          deals.push({
            externalId: card.asin,
            title: card.title,
            url: card.url.split("?")[0],
            imageUrl: upscaleAmazonImage(card.imageUrl ?? undefined),
            price: priced.price,
            listPrice: priced.listPrice,
            description: priced.description,
            currency: "EUR",
            availability: "in_stock",
            merchantId: "amazon",
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
  ): Promise<
    { price: number; listPrice?: number; description?: string } | undefined
  > {
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

    const [texts, bullets] = await Promise.all([
      page.evaluate(
        (selectorGroups) =>
          selectorGroups.map((selectors) => {
            for (const selector of selectors) {
              for (const el of Array.from(
                document.querySelectorAll(selector),
              )) {
                const text = el.textContent?.trim();
                if (text) {
                  return text;
                }
              }
            }
            return null;
          }),
        [PRICE_SELECTORS, LIST_PRICE_SELECTORS],
      ),
      this.fetchFeatureBullets(page),
    ]);

    const [priceText, listPriceText] = texts;
    if (!priceText) {
      return undefined;
    }

    const price = parsePriceFr(priceText);
    if (price === undefined) {
      return undefined;
    }

    const listPrice = listPriceText ? parsePriceFr(listPriceText) : undefined;

    return {
      price,
      listPrice:
        listPrice !== undefined && listPrice > price ? listPrice : undefined,
      description: bullets,
    };
  }

  /**
   * Amazon's "À propos de cet article" bullet list (`#feature-bullets`) is
   * real, merchant-written product info — what the item actually is and
   * does — as opposed to anything DealRadar would have to invent. Hidden
   * bullets (`.aok-hidden`, used for SEO-only filler text Amazon doesn't
   * actually display) are skipped. Falls back to the short product
   * description paragraph when there's no bullet list at all. Capped at a
   * handful of bullets / a few hundred characters: this ends up pasted
   * into a Dealabs post, not reproduced in full.
   */
  protected async fetchFeatureBullets(
    page: DealsPage,
  ): Promise<string | undefined> {
    const bullets = await page.evaluate(() => {
      const items = Array.from(
        document.querySelectorAll(
          "#feature-bullets ul.a-unordered-list li:not(.aok-hidden) span.a-list-item",
        ),
      )
        .map((el) => el.textContent?.replace(/\s+/g, " ").trim())
        .filter((text): text is string => !!text && text.length > 3);

      if (items.length > 0) {
        return items;
      }

      const fallback = document
        .querySelector("#productDescription p, #productDescription")
        ?.textContent?.replace(/\s+/g, " ")
        .trim();
      return fallback ? [fallback] : [];
    });

    if (bullets.length === 0) {
      return undefined;
    }

    const text = bullets
      .slice(0, 5)
      .map((line) => `- ${line}`)
      .join("\n");

    return text.length > 600 ? `${text.slice(0, 600)}…` : text;
  }
}

/**
 * Amazon's listing thumbnails come back at the size the carousel needed
 * (`..._AC_SF226,226_QL85_.jpg`) — far too small for a detail page hero,
 * and visibly soft even in a card. The size is encoded in the filename, so
 * asking the same CDN for a larger render is a string rewrite: no proxy, no
 * copy, and the original URL is still what gets requested.
 */
export function upscaleAmazonImage(url?: string): string | undefined {
  if (!url || !url.includes("media-amazon.com")) {
    return url;
  }
  return url.replace(/\._[A-Z0-9_,]+_\.(jpg|png|jpeg)/i, "._AC_SL800_.$1");
}
