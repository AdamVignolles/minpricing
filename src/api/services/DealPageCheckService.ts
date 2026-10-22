import { $env, z } from "alepha";
import { $logger } from "alepha/logger";

import { withBrowser, withPage } from "../collectors/browser.ts";
import {
  assessDealPage,
  type DealPageSnapshot,
  type DealPageVerdict,
  euroAmounts,
} from "./dealPageCheck.ts";

/**
 * Opens the merchant page in the local browser right before a publish and
 * checks it is up, the product still there and still at our price (see
 * {@link assessDealPage}). Local only, like publishing itself.
 */
export class DealPageCheckService {
  protected log = $logger();
  protected env = $env(
    z.object({
      /** Set to false to publish without opening the merchant page first. */
      PUBLISH_PAGE_CHECK: z.boolean().default(true),
    }),
  );

  get enabled(): boolean {
    return this.env.PUBLISH_PAGE_CHECK;
  }

  /**
   * Stores whose page never shows the price to a headless browser (Steam
   * never finishes loading, Nintendo loads it separately): read the same
   * public store API the collectors use instead. `undefined` = no API for
   * this source, use the page.
   */
  protected async storeApiSnapshot(deal: {
    sourceId: string;
    externalId: string;
    url: string;
  }): Promise<DealPageSnapshot | undefined> {
    if (deal.sourceId === "steam") {
      const appId = deal.url.match(/\/app\/(\d+)/)?.[1] ?? deal.externalId;
      if (!/^\d+$/.test(appId)) return undefined;
      const response = await fetch(
        `https://store.steampowered.com/api/appdetails?appids=${appId}&cc=fr&filters=basic,price_overview`,
        { signal: AbortSignal.timeout(20_000) },
      );
      const body = (await response.json()) as Record<
        string,
        {
          success: boolean;
          data?: {
            name?: string;
            is_free?: boolean;
            price_overview?: { final: number };
          };
        }
      >;
      const app = body[appId];
      if (!app?.success)
        return { status: 404, title: "Steam", text: "", prices: [] };
      const final = app.data?.price_overview?.final;
      return {
        status: response.status,
        title: app.data?.name ?? "Steam",
        text: "",
        prices:
          final !== undefined ? [final / 100] : app.data?.is_free ? [0] : [],
        availability: "https://schema.org/InStock",
      };
    }
    if (deal.sourceId === "nintendo") {
      const response = await fetch(
        `https://searching.nintendo-europe.com/fr/select?q=*&fq=fs_id:${encodeURIComponent(deal.externalId)}&rows=1&wt=json`,
        { signal: AbortSignal.timeout(20_000) },
      );
      const doc = (
        (await response.json()) as {
          response?: {
            docs?: {
              title?: string;
              price_discounted_f?: number;
              price_regular_f?: number;
            }[];
          };
        }
      ).response?.docs?.[0];
      if (!doc)
        return { status: 404, title: "Nintendo eShop", text: "", prices: [] };
      return {
        status: response.status,
        title: doc.title ?? "Nintendo eShop",
        text: "",
        prices: [doc.price_discounted_f ?? doc.price_regular_f].filter(
          (price): price is number => price !== undefined,
        ),
        availability: "https://schema.org/InStock",
      };
    }
    return undefined;
  }

  async check(deal: {
    id: string;
    url: string;
    currentPrice: number;
    sourceId: string;
    externalId: string;
  }): Promise<DealPageVerdict & { snapshot?: Omit<DealPageSnapshot, "text"> }> {
    let snapshot: DealPageSnapshot;
    try {
      snapshot =
        (await this.storeApiSnapshot(deal).catch(() => undefined)) ??
        (await withBrowser((browser) =>
          withPage(browser, async (page) => {
            const response = await page
              .goto(deal.url, {
                waitUntil: "domcontentloaded",
                timeout: 45_000,
              })
              .catch(() => null);
            // Prices are often rendered after the first paint (GOG, Nike…).
            await page.evaluate(
              () => new Promise((done) => setTimeout(done, 4_000)),
            );
            const read = await page.evaluate(() => {
              const offers: { price?: number; availability?: string }[] = [];
              const visit = (node: unknown): void => {
                if (!node || typeof node !== "object") return;
                if (Array.isArray(node)) {
                  node.forEach(visit);
                  return;
                }
                const record = node as Record<string, unknown>;
                if (
                  "price" in record ||
                  "lowPrice" in record ||
                  "availability" in record
                ) {
                  const value = Number(
                    String(record.price ?? record.lowPrice ?? "").replace(
                      ",",
                      ".",
                    ),
                  );
                  offers.push({
                    price:
                      Number.isFinite(value) && value > 0 ? value : undefined,
                    availability:
                      typeof record.availability === "string"
                        ? record.availability
                        : undefined,
                  });
                }
                Object.values(record).forEach(visit);
              };
              for (const script of Array.from(
                document.querySelectorAll('script[type="application/ld+json"]'),
              )) {
                try {
                  visit(JSON.parse(script.textContent ?? ""));
                } catch {
                  // Malformed JSON-LD: ignore.
                }
              }
              const metas = Array.from(
                document.querySelectorAll(
                  'meta[itemprop="price"], meta[property="product:price:amount"], meta[property="og:price:amount"]',
                ),
              )
                .map((meta) =>
                  Number(
                    (meta.getAttribute("content") ?? "").replace(",", "."),
                  ),
                )
                .filter((value) => Number.isFinite(value) && value > 0);
              const availability =
                offers.find((offer) => offer.availability)?.availability ??
                document
                  .querySelector('[itemprop="availability"]')
                  ?.getAttribute("href") ??
                undefined;
              return {
                title: document.title,
                text: (document.body?.innerText ?? "").slice(0, 200_000),
                structuredPrices: [
                  ...offers
                    .map((offer) => offer.price)
                    .filter((price): price is number => price !== undefined),
                  ...metas,
                ],
                availability,
              };
            });
            return {
              status: response?.status() ?? 0,
              title: read.title,
              text: read.text,
              prices: [...read.structuredPrices, ...euroAmounts(read.text)],
              availability: read.availability,
            };
          }),
        ));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.warn("Merchant page check failed to load", {
        dealId: deal.id,
        error: message,
      });
      return {
        ok: false,
        reason: `page marchand impossible à charger (${message.slice(0, 120)})`,
      };
    }
    const verdict = assessDealPage(snapshot, deal);
    const { text: _text, ...summary } = snapshot;
    this.log.info("Merchant page checked before publish", {
      dealId: deal.id,
      ok: verdict.ok,
      reason: verdict.ok ? undefined : verdict.reason,
    });
    return {
      ...verdict,
      snapshot: { ...summary, prices: summary.prices.slice(0, 20) },
    };
  }
}
