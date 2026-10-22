import {
  type CloudflareBrowserBinding,
  withBrowser,
  withPage,
} from "./browser.ts";
import type { DealSource, DiscoverContext, RawDeal } from "./DealSource.ts";

/**
 * Carrefour's non-food deals page (high-tech, appliances, home). Unlike
 * the food promotions (loyalty-card "-10 % CLUB", "le 2ème à -60 %"),
 * these are plain price drops: "199,99 € au lieu de 299,99 €". The site
 * answers 403 to plain requests, so it is read in the browser.
 */
const CARREFOUR_PAGES = [
  "https://www.carrefour.fr/boutique/bons-plans-high-tech-maison",
];

interface CarrefourCard {
  ean: string;
  href: string | null;
  title: string;
  brand: string;
  image: string | null;
  text: string;
  promo: string;
}

/** "199 ,99 € au lieu de 299,99 €" → [199.99, 299.99]. */
export function parseCarrefourPrices(
  text: string,
): { price: number; listPrice: number } | undefined {
  const match = text.match(
    /(\d[\d\s]*?)\s*,\s*(\d{2})\s*€\s*au lieu de\s*(\d[\d\s]*?)\s*,\s*(\d{2})\s*€/,
  );
  if (!match) return undefined;
  const price = Number(`${match[1].replace(/\s/g, "")}.${match[2]}`);
  const listPrice = Number(`${match[3].replace(/\s/g, "")}.${match[4]}`);
  return price < listPrice ? { price, listPrice } : undefined;
}

export class CarrefourCollector implements DealSource {
  id = "carrefour";
  name = "Carrefour (bons plans high-tech & maison)";

  constructor(
    protected getCloudflareBinding?: () => CloudflareBrowserBinding | undefined,
  ) {}

  async discover(context?: DiscoverContext): Promise<RawDeal[]> {
    return withBrowser(async (browser) => {
      const deals = new Map<string, RawDeal>();
      for (const [index, url] of CARREFOUR_PAGES.entries()) {
        context?.progress?.(
          "Bons plans high-tech & maison",
          index + 1,
          CARREFOUR_PAGES.length,
        );
        try {
          const cards = await withPage(browser, async (page) => {
            await page.goto(url, {
              waitUntil: "domcontentloaded",
              timeout: 30_000,
            });
            await page
              .waitForSelector("article[data-testid]", { timeout: 15_000 })
              .catch(() => undefined);
            // The grid loads more cards as it scrolls.
            await page.evaluate(async () => {
              for (let i = 0; i < 6; i++) {
                window.scrollBy(0, 2500);
                await new Promise((resolve) => setTimeout(resolve, 800));
              }
            });
            return page.evaluate(() =>
              Array.from(document.querySelectorAll("article[data-testid]")).map(
                (el): CarrefourCard => ({
                  ean: el.getAttribute("data-testid") ?? "",
                  href:
                    el
                      .querySelector<HTMLAnchorElement>('a[href^="/p/"]')
                      ?.getAttribute("href") ?? null,
                  title:
                    el
                      .querySelector(".product-card-title__text")
                      ?.textContent?.trim() ?? "",
                  brand:
                    el
                      .querySelector('[class*="__brand"]')
                      ?.textContent?.trim() ?? "",
                  image: el.querySelector("img")?.getAttribute("src") ?? null,
                  text: (el as HTMLElement).innerText.replace(/\s+/g, " "),
                  promo:
                    el
                      .querySelector(".sticker-promo__text")
                      ?.textContent?.trim() ?? "",
                }),
              ),
            );
          });
          for (const card of cards) {
            const prices = parseCarrefourPrices(card.text);
            if (!/^\d{8,14}$/.test(card.ean) || !card.href || !card.title) {
              continue;
            }
            if (!prices || deals.has(card.ean)) continue;
            deals.set(card.ean, {
              externalId: card.ean,
              // The brand is usually already at the end of the title.
              title: card.title.toUpperCase().includes(card.brand.toUpperCase())
                ? card.title
                : `${card.brand} ${card.title}`.trim(),
              url: `https://www.carrefour.fr${card.href}`,
              imageUrl:
                card.image?.replace("p_200x200", "p_540x540") ?? undefined,
              price: prices.price,
              listPrice: prices.listPrice,
              currency: "EUR",
              availability: "in_stock",
              merchantId: "carrefour",
              description: card.promo
                ? `Offre Carrefour : ${card.promo}.`
                : undefined,
              details: {
                ean: card.ean,
                sellerName: "Carrefour",
                soldByMerchant: true,
                shippedByMerchant: true,
                condition: "new",
                listPriceKind: "regular",
              },
            });
          }
        } catch {
          // A page failing (challenge, layout change) skips it, not the run.
        }
      }
      return [...deals.values()];
    }, this.getCloudflareBinding?.());
  }
}
