import type { CloudflareBrowserBinding } from "./browser.ts";
import {
  parsePriceFr,
  scrollAndCollect,
  withBrowser,
  withPage,
} from "./browser.ts";
import type { DealSource, RawDeal } from "./DealSource.ts";

/**
 * Auto-discovers current Cdiscount deals from one or more listing pages
 * (the homepage's "Bons plans" carousel, plus optionally dedicated
 * promotion/category pages) — several entry points so a single narrow
 * carousel isn't the only source of candidates. Unlike Amazon, Cdiscount
 * exposes stable `data-e2e="..."` test attributes on its offer cards
 * (title, price, image) that survive their frequent CSS-class renaming
 * (styled-components hashes change on every build), so a page visit per
 * URL is enough — no need to open each product page separately. Cards are
 * de-duplicated by URL across all listing pages before the `limit` cap is
 * applied.
 */
export class CdiscountCollector implements DealSource {
  id = "cdiscount";
  name = "Cdiscount (bons plans, auto)";

  protected readonly homeUrls: string[];

  constructor(
    homeUrls: string | string[],
    protected limit = 60,
    /** See {@link AmazonCollector}'s constructor doc — same deal. */
    protected getCloudflareBinding?: () => CloudflareBrowserBinding | undefined,
  ) {
    this.homeUrls = Array.isArray(homeUrls) ? homeUrls : [homeUrls];
  }

  async discover(): Promise<RawDeal[]> {
    return withBrowser(async (browser) => {
      const cardsByUrl = new Map<
        string,
        {
          url: string;
          title: string;
          priceText: string;
          listPriceText: string | null;
          imageUrl: string | null;
        }
      >();

      for (const homeUrl of this.homeUrls) {
        try {
          const cards = await withPage(browser, async (page) => {
            const response = await page.goto(homeUrl, {
              waitUntil: "networkidle",
              timeout: 20_000,
            });
            if (!response || !response.ok()) {
              throw new Error(
                `Cdiscount page returned ${response?.status() ?? "no response"}`,
              );
            }

            await page
              .waitForSelector('[data-e2e="offer-item"]', { timeout: 10_000 })
              .catch(() => {
                // No card showed up in time: the extract() below just
                // finds none, and this URL simply contributes 0 cards.
              });

            // Collected across every scroll step, not read once at the
            // end — see `scrollAndCollect`'s doc.
            return scrollAndCollect(
              page,
              () =>
                page.evaluate(() =>
                  Array.from(
                    document.querySelectorAll('[data-e2e="offer-item"]'),
                  ).map((el) => {
                    const link = el.closest("a") as HTMLAnchorElement | null;
                    const title =
                      el
                        .querySelector('[data-e2e="lplr-title"]')
                        ?.textContent?.trim() ?? null;
                    const priceText =
                      el
                        .querySelector('[data-e2e="lplr-price"]')
                        ?.textContent?.trim() ?? null;
                    // Measured 2026-10: the homepage offer cards expose
                    // only `lplr-price` — there is no struck-through
                    // reference price in the markup, just a
                    // "Promo"/"Bon plan" ribbon. So this lookup
                    // legitimately returns nothing today and Cdiscount
                    // deals ship without a discount rather than with a
                    // fabricated one.
                    //
                    // It is kept because Cdiscount renames its
                    // struck-price hook regularly and sometimes falls
                    // back to plain <del>/<s>: if the reference price
                    // comes back, we pick it up for free.
                    const listPriceText =
                      el
                        .querySelector(
                          '[data-e2e*="strike" i], [data-e2e*="crossed" i], [data-e2e="lplr-oldPrice"], del, s',
                        )
                        ?.textContent?.trim() ?? null;
                    const img = el.querySelector(
                      "img",
                    ) as HTMLImageElement | null;
                    return {
                      url: link?.href ?? null,
                      title,
                      priceText,
                      listPriceText,
                      imageUrl: img?.src || null,
                    };
                  }),
                ),
              (card) => card.url?.split("#")[0],
            );
          });

          for (const card of cards) {
            if (!card.url || !card.title || !card.priceText) {
              continue;
            }
            const url = card.url.split("#")[0];
            if (!cardsByUrl.has(url)) {
              cardsByUrl.set(url, {
                url,
                title: card.title,
                priceText: card.priceText,
                listPriceText: card.listPriceText,
                imageUrl: card.imageUrl,
              });
            }
          }
        } catch {
          // One listing page failing must not block the other entry
          // points from contributing cards.
        }
      }

      const deals: RawDeal[] = [];
      for (const card of Array.from(cardsByUrl.values()).slice(0, this.limit)) {
        const price = parsePriceFr(card.priceText);
        if (price === undefined) {
          continue;
        }

        const listPrice = card.listPriceText
          ? parsePriceFr(card.listPriceText)
          : undefined;

        deals.push({
          externalId: card.url,
          title: card.title,
          url: card.url,
          imageUrl: card.imageUrl ?? undefined,
          price,
          listPrice:
            listPrice !== undefined && listPrice > price
              ? listPrice
              : undefined,
          currency: "EUR",
          availability: "in_stock",
          merchantId: "cdiscount",
        });
      }

      return deals;
    }, this.getCloudflareBinding?.());
  }
}
