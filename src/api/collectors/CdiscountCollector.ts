import type { CloudflareBrowserBinding } from "./browser.ts";
import { parsePriceFr, withBrowser, withPage } from "./browser.ts";
import type { DealSource, RawDeal } from "./DealSource.ts";

/**
 * Auto-discovers current Cdiscount deals from the homepage's "Bons plans"
 * carousel. Unlike Amazon, Cdiscount exposes stable `data-e2e="..."` test
 * attributes on its offer cards (title, price, image) that survive their
 * frequent CSS-class renaming (styled-components hashes change on every
 * build), so a single page visit is enough — no need to open each product
 * page separately.
 */
export class CdiscountCollector implements DealSource {
  id = "cdiscount";
  name = "Cdiscount (bons plans, auto)";

  constructor(
    protected homeUrl: string,
    protected limit = 12,
    /** See {@link AmazonCollector}'s constructor doc — same deal. */
    protected cloudflareBinding?: CloudflareBrowserBinding,
  ) {}

  async discover(): Promise<RawDeal[]> {
    return withBrowser(
      (browser) =>
        withPage(browser, async (page) => {
          const response = await page.goto(this.homeUrl, {
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
              // No card showed up in time: the evaluate() below just finds
              // none, and this run reports 0 deals rather than throwing.
            });

          const cards = await page.evaluate(() =>
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
              const img = el.querySelector("img") as HTMLImageElement | null;
              return {
                url: link?.href ?? null,
                title,
                priceText,
                imageUrl: img?.src || null,
              };
            }),
          );

          const deals: RawDeal[] = [];
          for (const card of cards.slice(0, this.limit)) {
            if (!card.url || !card.title || !card.priceText) {
              continue;
            }

            const price = parsePriceFr(card.priceText);
            if (price === undefined) {
              continue;
            }

            const url = card.url.split("#")[0];
            deals.push({
              externalId: url,
              title: card.title,
              url,
              imageUrl: card.imageUrl ?? undefined,
              price,
              currency: "EUR",
              availability: "in_stock",
            });
          }

          return deals;
        }),
      this.cloudflareBinding,
    );
  }
}
