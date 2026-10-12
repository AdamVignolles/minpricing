import {
  parseAliExpressSignals,
  parseCardBadges,
} from "./aliexpressSignals.ts";
import type { CloudflareBrowserBinding, DealsPage } from "./browser.ts";
import {
  interleave,
  parsePriceFr,
  scrollAndCollect,
  withBrowser,
  withPage,
} from "./browser.ts";
import type {
  DealDetails,
  DealSource,
  DiscoverContext,
  RawDeal,
} from "./DealSource.ts";

/**
 * Auto-discovers AliExpress deals from its "Deal du Jour" listing (and any
 * other listing page configured): every card carries the product id,
 * title, price and image, so the listing alone is enough to create the
 * deal. The product page — store, reviews, units sold, the store's own
 * "original price", shipping — is only opened for new or stale deals (see
 * `DiscoverContext`), like Cdiscount.
 *
 * AliExpress is a marketplace of third-party stores: there is no "sold by
 * the platform" case, and the struck "original price" is the store's own
 * figure, so it's scored as a "prix conseillé" (half weight).
 */
export class AliExpressCollector implements DealSource {
  id = "aliexpress";
  name = "AliExpress (deals du jour)";

  protected readonly urls: string[];

  constructor(
    urls: string | string[],
    protected limit = 40,
    /** See {@link AmazonCollector}'s constructor doc — same deal. */
    protected getCloudflareBinding?: () => CloudflareBrowserBinding | undefined,
  ) {
    this.urls = Array.isArray(urls) ? urls : [urls];
  }

  async discover(context?: DiscoverContext): Promise<RawDeal[]> {
    return withBrowser(async (browser) => {
      type Card = {
        id: string;
        title: string;
        priceText: string;
        imageUrl: string | null;
        lowestInDays?: number;
        categoryHint?: string;
        shipsFrom?: string;
      };
      const cardsPerPage: Card[][] = [];

      for (const [pageIndex, url] of this.urls.entries()) {
        // Search pages say what they are: `/w/wholesale-smartphone.html`
        // → "aliexpress:smartphone"; `shipFromCountry=FR` → ships from FR.
        const term = url.match(/wholesale-([a-z0-9-]+)\.html/i)?.[1];
        const categoryHint = term ? `aliexpress:${term}` : undefined;
        const shipsFrom =
          new URL(url).searchParams.get("shipFromCountry") ?? undefined;
        context?.progress?.(
          "Lecture des pages deals",
          pageIndex + 1,
          this.urls.length,
        );
        try {
          const cards = await withPage(browser, async (page) => {
            await page.goto(url, {
              waitUntil: "domcontentloaded",
              timeout: 30_000,
            });
            await page
              .waitForSelector('a[href*="/item/"]', { timeout: 15_000 })
              .catch(() => {
                // No card rendered: this page contributes nothing.
              });
            return scrollAndCollect(
              page,
              () =>
                page.evaluate(() =>
                  Array.from(
                    document.querySelectorAll('a[href*="/item/"]'),
                  ).map((el) => {
                    const link = el as HTMLAnchorElement;
                    const id = link.href.match(/\/item\/(\d+)/)?.[1] ?? null;
                    // Card text: title, price, stock label, rating.
                    const lines = (link.innerText ?? "")
                      .split("\n")
                      .map((line) => line.trim())
                      .filter(Boolean);
                    const title =
                      link
                        .querySelector("[aria-label]")
                        ?.getAttribute("aria-label") ??
                      lines[0] ??
                      null;
                    const priceText =
                      lines.find((line) => /\d+[,.]\d{2}\s?€/.test(line)) ??
                      null;
                    const img = link.querySelector(
                      "img",
                    ) as HTMLImageElement | null;
                    return {
                      id,
                      title,
                      priceText,
                      imageUrl: img?.src || null,
                      lines,
                    };
                  }),
                ),
              (card) => card.id,
              { rounds: 8 },
            );
          });
          cardsPerPage.push(
            cards
              .filter((card) => card.id && card.title && card.priceText)
              .map((card) => ({
                id: card.id as string,
                title: card.title as string,
                priceText: card.priceText as string,
                imageUrl: card.imageUrl,
                lowestInDays: parseCardBadges(card.lines).lowestInDays,
                categoryHint,
                shipsFrom,
              })),
          );
        } catch {
          // One listing page failing must not block the others.
        }
      }

      const candidates = interleave(cardsPerPage, (card) => card.id).slice(
        0,
        this.limit,
      );
      const toEnrich = candidates.filter(
        (card) => !context || context.needsDetails(card.id),
      ).length;
      let enriched = 0;

      const deals: RawDeal[] = [];
      for (const card of candidates) {
        const listingPrice = parsePriceFr(card.priceText);
        if (listingPrice === undefined) continue;
        const url = `https://fr.aliexpress.com/item/${card.id}.html`;

        let details:
          | (DealDetails & { price?: number; originalPrice?: number })
          | undefined;
        if (!context || context.needsDetails(card.id)) {
          enriched++;
          context?.progress?.(
            "Fiches produits (boutique, avis, livraison)",
            enriched,
            toEnrich,
          );
          details = await withPage(browser, (page) =>
            this.fetchDetails(page, url),
          ).catch(() => undefined);
        }

        // The product page price is the default variant's; the listing's
        // is what the deal page advertised. Prefer the page when read.
        const price = details?.price ?? listingPrice;
        const { price: _price, originalPrice, ...signals } = details ?? {};
        deals.push({
          externalId: card.id,
          title: card.title,
          url,
          imageUrl: card.imageUrl ?? undefined,
          price,
          listPrice: originalPrice,
          currency: "EUR",
          availability: "in_stock",
          merchantId: "aliexpress",
          categoryHint: card.categoryHint,
          details: details
            ? {
                ...signals,
                shipsFrom: card.shipsFrom,
                // AliExpress' own "lowest price in 90 days" badge: the
                // platform's claim, kept with its source.
                ...(card.lowestInDays
                  ? {
                      historicalLowPrice: price,
                      historicalLowSource: `AliExpress, plus bas en ${card.lowestInDays} jours`,
                    }
                  : {}),
              }
            : undefined,
        });
      }
      return deals;
    }, this.getCloudflareBinding?.());
  }

  protected async fetchDetails(page: DealsPage, url: string) {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page
      .waitForSelector('[class*="price-default--current"]', {
        timeout: 12_000,
      })
      .catch(() => {
        // Price block didn't render: parse whatever is there.
      });
    const text = await page.evaluate(() => {
      // AliExpress class names carry a build hash ("price-default--current--F8OlYIo"):
      // match on the stable prefix.
      const read = (selector: string) =>
        (document.querySelector(selector) as HTMLElement | null)?.innerText
          ?.replace(/\s+/g, " ")
          .trim() || undefined;
      return {
        currentPrice: read('[class*="price-default--current"]'),
        originalPrice: read('[class*="price-default--original"]'),
        reviewer: read('[class*="reviewer--wrap"]'),
        storeName:
          read('[class*="store-detail--storeName"]') ??
          read('[class*="store-info--name"]') ??
          read('[data-pl="store-name"]'),
        shipping: read('[class*="shipping--content"]'),
      };
    });
    return parseAliExpressSignals(text);
  }
}
