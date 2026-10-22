import type { CloudflareBrowserBinding, DealsPage } from "./browser.ts";
import {
  interleave,
  mapWithConcurrency,
  parsePriceFr,
  scrollAndCollect,
  withBrowser,
  withPage,
} from "./browser.ts";
import {
  buildCdiscountDescription,
  cheapestCredibleOffer,
  isCdiscount,
  parseCdiscountOffersLayer,
  parseComparisonPrice,
  parseCondition,
  parseOffersSummary,
  parseSellerLine,
} from "./cdiscountOffers.ts";
import type {
  DealDetails,
  DealSource,
  DiscoverContext,
  RawDeal,
} from "./DealSource.ts";

/** Listing pages read at the same time. */
const LISTING_CONCURRENCY = 2;

/** Product pages opened at the same time (see AmazonCollector). */
const PAGE_CONCURRENCY = 3;

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

  async discover(context?: DiscoverContext): Promise<RawDeal[]> {
    return withBrowser(async (browser) => {
      type Card = {
        url: string;
        title: string;
        priceText: string;
        listPriceText: string | null;
        imageUrl: string | null;
      };
      // One list per listing page, interleaved below: the category hubs
      // are visited after the general promo pages, and a plain "first come
      // first served" cap let those general pages fill the whole limit —
      // which is why nearly every deal used to be high-tech.
      const cardsPerPage: Card[][] = [];

      // Listing pages a few at a time too (each in its own context).
      let pagesRead = 0;
      const perPage = await mapWithConcurrency(
        this.homeUrls,
        LISTING_CONCURRENCY,
        async (homeUrl): Promise<Card[]> => {
          context?.progress?.(
            "Lecture des pages promos et catégories",
            ++pagesRead,
            this.homeUrls.length,
          );
          try {
            const cards = await withPage(browser, async (page) => {
              const response = await page.goto(homeUrl, {
                // Not "networkidle": with several pages loading at once the
                // network is never quiet for long, and the page was dropped
                // with all its cards. The offer cards are what we wait for.
                waitUntil: "domcontentloaded",
                timeout: 30_000,
              });
              if (!response || !response.ok()) {
                throw new Error(
                  `Cdiscount page returned ${response?.status() ?? "no response"}`,
                );
              }

              await page
                .waitForSelector('[data-e2e="offer-item"]', { timeout: 20_000 })
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
                      const text = el.textContent ?? "";
                      return {
                        url: link?.href ?? null,
                        title,
                        priceText,
                        listPriceText,
                        imageUrl: img?.src || null,
                        // Category hubs mix promotions with regular-priced
                        // bestsellers: only cards Cdiscount itself marks as
                        // a promotion are deal candidates.
                        promo:
                          /Prix de comparaison|-\s?\d+\s?%|Promo|Bon plan|Soldes|Prix choc|Vente flash|Déstockage/i.test(
                            text,
                          ),
                        sponsored: /Sponsoris/i.test(text),
                      };
                    }),
                  ),
                (card) => card.url?.split("#")[0],
                // Hubs show their promotions near the top: a few scroll
                // steps are enough, and keep ten pages from taking minutes.
                { rounds: 8 },
              );
            });

            return cards
              .filter(
                (card) =>
                  card.url &&
                  card.title &&
                  card.priceText &&
                  card.promo &&
                  !card.sponsored,
              )
              .map((card) => ({
                url: (card.url as string).split("#")[0],
                title: card.title as string,
                priceText: card.priceText as string,
                listPriceText: card.listPriceText,
                imageUrl: card.imageUrl,
              }));
          } catch {
            // One listing page failing must not block the other entry
            // points from contributing cards.
            return [];
          }
        },
      );
      cardsPerPage.push(...perPage);

      const deals: RawDeal[] = [];
      // Titles that already disqualify an offer (low-end laptop…) never
      // cost a product-page load.
      const candidates = interleave(cardsPerPage, (card) => card.url)
        .filter((card) => context?.worthFetching?.(card.title) ?? true)
        .slice(0, this.limit);
      const toEnrich = candidates.filter(
        (card) => !context || context.needsDetails(card.url),
      ).length;
      let enriched = 0;
      // Product pages a few at a time (each in its own context): the
      // slowest part of a Cdiscount run when many deals are new.
      const found = await mapWithConcurrency(
        candidates,
        PAGE_CONCURRENCY,
        async (card): Promise<RawDeal | undefined> => {
          const price = parsePriceFr(card.priceText);
          if (price === undefined) {
            return undefined;
          }

          const listPrice = card.listPriceText
            ? parsePriceFr(card.listPriceText)
            : undefined;

          // The product page is where the seller, the competing offers and
          // the reviews live — the listing card shows none of them. Only
          // opened when this deal's details are stale (see DiscoverContext):
          // one extra page per new deal, not one per deal per run.
          let fetched: CdiscountProductPage | undefined;
          if (!context || context.needsDetails(card.url)) {
            try {
              fetched = await withPage(browser, (page) =>
                this.fetchDetails(page, card.url, price),
              );
            } catch {
              // Product page failed (timeout, layout change): keep the deal,
              // just without details this run — it'll be retried next run.
            }
            context?.progress?.(
              "Fiches produits (vendeur, offres, avis)",
              ++enriched,
              toEnrich,
            );
          }

          // Listing cards rarely carry the struck price; the product page's
          // "Prix de comparaison" does.
          const referencePrice = fetched?.comparisonPrice ?? listPrice;
          const struck =
            referencePrice !== undefined && referencePrice > price
              ? referencePrice
              : undefined;

          return {
            externalId: card.url,
            title: card.title,
            url: card.url,
            imageUrl: card.imageUrl ?? undefined,
            price,
            listPrice: struck,
            description: fetched?.description,
            currency: "EUR",
            availability: "in_stock",
            merchantId: "cdiscount",
            categoryHint: cdiscountCategoryHint(card.url),
            details: fetched
              ? {
                  ...fetched.details,
                  // Cdiscount's struck price is a "Prix de comparaison" it
                  // chooses itself, not a former selling price.
                  listPriceKind: struck !== undefined ? "rrp" : undefined,
                }
              : undefined,
          };
        },
      );
      deals.push(...found.filter((deal): deal is RawDeal => !!deal));

      return deals;
    }, this.getCloudflareBinding?.());
  }

  /**
   * Reads, from one product page: the schema.org JSON-LD block (EAN,
   * rating, condition — far more stable than any CSS hook), the "Vendu
   * par X et expédié par Y" line, and — when several sellers compete —
   * the offers layer behind the "N offres à partir de X €" button, which
   * is the only place the seller's rating and sales count are shown.
   */
  protected async fetchDetails(
    page: DealsPage,
    url: string,
    price: number,
  ): Promise<CdiscountProductPage | undefined> {
    const response = await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 20_000,
    });
    if (!response || !response.ok()) {
      return undefined;
    }

    await page
      .waitForSelector('[data-e2e="title"], [data-e2e="price"]', {
        timeout: 10_000,
      })
      .catch(() => {
        // Page shell without product markup: the evaluate() below just
        // finds nothing and the deal ships without details.
      });

    const onPage = await page.evaluate(() => {
      let ean: string | undefined;
      let rating: number | undefined;
      let reviewCount: number | undefined;
      let condition: string | undefined;
      for (const script of Array.from(
        document.querySelectorAll('script[type="application/ld+json"]'),
      )) {
        try {
          const json = JSON.parse(script.textContent ?? "null");
          if (!/product/i.test(String(json?.["@type"] ?? ""))) continue;
          ean = json.gtin ?? json.gtin13 ?? json.ean ?? ean;
          rating = json.aggregateRating?.ratingValue ?? rating;
          reviewCount =
            json.aggregateRating?.ratingCount ??
            json.aggregateRating?.reviewCount ??
            reviewCount;
          condition = json.offers?.itemCondition ?? condition;
        } catch {
          // Not valid JSON-LD: try the next script tag.
        }
      }

      // Scoped to the delivery block first: product descriptions can
      // contain "Vendu par lot de 4…", which is not a seller.
      const scope =
        document.querySelector('[data-e2e="product-shipping"]') ??
        document.body;
      const sellerEl = Array.from(scope.querySelectorAll("*"))
        .filter(
          (el) =>
            /^\s*Vendu (et expédié )?par/i.test(el.textContent ?? "") &&
            (el.textContent ?? "").length < 200,
        )
        .sort(
          (a, b) => (a.textContent ?? "").length - (b.textContent ?? "").length,
        )[0];

      // innerText of the block around the price, where Cdiscount prints
      // "Prix de comparaison 499,99 € 279 €99".
      let priceArea = document.querySelector('[data-e2e="price"]');
      for (let i = 0; i < 3 && priceArea?.parentElement; i++) {
        priceArea = priceArea.parentElement;
      }

      // Product sheet: "Points forts" lines and the technical table's
      // label/value rows (two cells each).
      const strengths = (
        (
          document.querySelector(
            '[data-e2e="product-strengths"]',
          ) as HTMLElement | null
        )?.innerText ?? ""
      ).split("\n");
      const specs = Array.from(
        document.querySelectorAll('[data-e2e="product-description-block"] tr'),
      )
        .map((row) => Array.from(row.children) as HTMLElement[])
        .filter((cells) => cells.length >= 2)
        .map(
          (cells) =>
            [cells[0].innerText.trim(), cells[1].innerText.trim()] as [
              string,
              string,
            ],
        );

      return {
        strengths,
        specs,
        priceAreaText: (priceArea as HTMLElement | null)?.innerText ?? "",
        ean: ean ? String(ean) : undefined,
        rating: rating !== undefined ? Number(rating) : undefined,
        reviewCount:
          reviewCount !== undefined ? Number(reviewCount) : undefined,
        condition,
        title: document.querySelector('[data-e2e="title"]')?.textContent ?? "",
        sellerText: sellerEl?.textContent ?? "",
        offersText:
          document.querySelector('[data-e2e="offers-list"]')?.textContent ?? "",
      };
    });

    const seller = parseSellerLine(onPage.sellerText);
    const summary = parseOffersSummary(onPage.offersText);
    // JSON-LD says "NewCondition" even for refurbished phones; the title
    // ("… - Reconditionné - Excellent état") is the honest signal.
    const condition =
      parseCondition(onPage.title) ??
      (/Refurbished/i.test(onPage.condition ?? "")
        ? "refurbished"
        : /Used/i.test(onPage.condition ?? "")
          ? "used"
          : "new");

    const soldByCdiscount = seller.sellerName
      ? isCdiscount(seller.sellerName)
      : undefined;
    const details: DealDetails = {
      ean: onPage.ean && /^\d{8,14}$/.test(onPage.ean) ? onPage.ean : undefined,
      productRating: onPage.rating,
      productReviewCount: onPage.reviewCount,
      condition,
      sellerName: seller.sellerName,
      soldByMerchant: soldByCdiscount,
      // "Vendu par Cdiscount" with no shipper named: Cdiscount ships it.
      shippedByMerchant: seller.shipper
        ? isCdiscount(seller.shipper)
        : soldByCdiscount || undefined,
      offersCount: summary.offersCount,
    };
    const comparisonPrice = parseComparisonPrice(onPage.priceAreaText);
    const specValue = (label: RegExp) =>
      onPage.specs.find(([name]) => label.test(name))?.[1];
    const description = buildCdiscountDescription({
      summary:
        specValue(/^Description du produit/i) ?? specValue(/^Plus produit/i),
      strengths: onPage.strengths,
      specs: onPage.specs,
    });

    // Only one offer: nothing to compare against, and no layer to open.
    if (!summary.offersCount || summary.offersCount < 2) {
      return { details, comparisonPrice, description };
    }

    const lines = await page.evaluate(
      (timeoutMs) =>
        new Promise<string[]>((resolve) => {
          // The button is server-rendered, but its click handler only
          // exists once React has hydrated — a click sent too early is
          // silently lost. So keep clicking until the layer shows up.
          let lastClick = 0;
          const click = () => {
            lastClick = Date.now();
            (
              document.querySelector(
                '[data-e2e="offers-list"] button',
              ) as HTMLButtonElement | null
            )?.click();
          };
          click();
          const started = Date.now();
          const read = () =>
            (
              (document.querySelector(".layer-content") as HTMLElement | null)
                ?.innerText ?? ""
            )
              .split("\n")
              .map((line) => line.trim())
              .filter(Boolean);
          const poll = () => {
            const text = read().join("\n");
            // Done once the competing offers have rendered (each ends with
            // "Voir l'offre"), not just the current one ("Chargement…").
            const loaded =
              /Voir l.offre/i.test(text) &&
              !/Chargement des offres/i.test(text);
            if (loaded || Date.now() - started > timeoutMs) {
              resolve(read());
              return;
            }
            if (
              !document.querySelector(".layer-content") &&
              Date.now() - lastClick > 1_000
            ) {
              click();
            }
            setTimeout(poll, 250);
          };
          poll();
        }),
      12_000,
    );

    const layer = parseCdiscountOffersLayer(lines);
    const current = layer.current;
    if (current) {
      details.sellerName = current.sellerName ?? details.sellerName;
      details.soldByMerchant = isCdiscount(details.sellerName);
      details.shippedByMerchant = current.shipper
        ? isCdiscount(current.shipper)
        : details.shippedByMerchant;
      details.sellerRating = current.sellerRating;
      details.sellerSalesCount = current.sellerSalesCount;
    }

    const cheapest = cheapestCredibleOffer(layer.others, condition);
    if (cheapest) {
      details.bestOtherOfferPrice = cheapest.price;
    } else if (
      layer.others.length === 0 &&
      summary.fromPrice !== undefined &&
      summary.fromPrice < price
    ) {
      // The layer didn't render, but the summary alone proves a cheaper
      // offer exists (seller unknown, so it can't be vetted — still worth
      // knowing).
      details.bestOtherOfferPrice = summary.fromPrice;
    }

    return { details, comparisonPrice, description };
  }
}

/**
 * Cdiscount product URLs start with their catalogue section —
 * `/maison/…`, `/le-sport/…`, `/pret-a-porter/bebe-puericulture/…` — which
 * is the merchant's own category for the product.
 */
export function cdiscountCategoryHint(url: string): string | undefined {
  try {
    const [section, sub] = new URL(url).pathname.split("/").filter(Boolean);
    return section ? `cdiscount:${section}${sub ? `/${sub}` : ""}` : undefined;
  } catch {
    return undefined;
  }
}

interface CdiscountProductPage {
  details: DealDetails;
  /** The page's "Prix de comparaison", when it shows one. */
  comparisonPrice?: number;
  /** Built from the product sheet, see `buildCdiscountDescription`. */
  description?: string;
}
