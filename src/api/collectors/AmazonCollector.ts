import {
  type AmazonProductRead,
  fetchAmazonProduct,
  fetchAmazonProductPage,
  parseAmazonFacts,
} from "./amazonProductHtml.ts";
import { type AmazonPageText, parseAmazonSignals } from "./amazonSignals.ts";
import type { CloudflareBrowserBinding, DealsPage } from "./browser.ts";
import {
  interleave,
  mapWithConcurrency,
  parsePriceFr,
  isRobotCheckPage,
  readProductPages,
  scrollAndCollect,
  withBrowser,
  withDeadline,
  withPage,
} from "./browser.ts";
import type {
  DealDetails,
  DealSource,
  DiscoverContext,
  ProductRef,
  RawDeal,
} from "./DealSource.ts";
import { currentLoad, noteTiming, percentile } from "./runTimings.ts";

/** Cards announcing less than this ("-12 %") aren't worth opening. */
const MIN_BADGE_PERCENT = 20;
/**
 * Overall limits per page, above the steps' own timeouts (goto 25 s, price
 * 12 s; a listing scrolls 10 rounds): past them the page is given up so one
 * hung browser call can't hold the run (`withDeadline`).
 */
const PRODUCT_PAGE_DEADLINE_MS = 90_000;
const LISTING_PAGE_DEADLINE_MS = 180_000;

/** Listing pages read at the same time. */
const LISTING_CONCURRENCY = 2;

/**
 * Product pages opened at the same time. Higher is faster but looks less
 * like a person browsing: 3 kept Amazon's pages intact in testing.
 */
const PAGE_CONCURRENCY = 3;

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
 * One product page read, as the offer collection stores it — shared by
 * the server's reads and a page read in the owner's browser (« Lire dans
 * DealRadar », `CollectionService.checkLinkFromPage`).
 */
export function amazonRawDeal(
  asin: string,
  priced: Pick<
    AmazonProductRead,
    | "title"
    | "imageUrl"
    | "price"
    | "listPrice"
    | "description"
    | "breadcrumb"
    | "details"
  >,
  product?: { id?: string; title?: string },
): RawDeal {
  return {
    externalId: asin,
    productId: product?.id,
    title: priced.title || product?.title || asin,
    url: `https://www.amazon.fr/dp/${asin}`,
    imageUrl: upscaleAmazonImage(priced.imageUrl),
    price: priced.price,
    listPrice: priced.listPrice,
    description: priced.description,
    currency: "EUR",
    availability: "in_stock",
    merchantId: "amazon",
    categoryHint: priced.breadcrumb
      ? `amazon-crumb:${priced.breadcrumb}`
      : undefined,
    details: priced.details,
  };
}

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

  protected dealsUrls: string[];

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

  /**
   * Pages and per-run cap for the next run — `CollectionService` applies
   * `config/collection.json` (tuned by the local agents) before each run.
   */
  setTargets(dealsUrls: string[], limit: number): void {
    this.dealsUrls = dealsUrls;
    this.limit = limit;
  }

  /**
   * Read product pages over plain HTTP first (about 3x faster, no CPU-hungry
   * Chromium), the browser only when that gets no price. Off on Cloudflare,
   * where the browser binding is the only way out. Rollback switch:
   * `sources.amazon.fetchFirst: false` in `config/collection.json`.
   */
  setFetchFirst(enabled: boolean): void {
    this.fetchFirst = enabled;
  }

  protected fetchFirst = true;

  /**
   * Pasted links are read one at a time, this far apart (ms, random in
   * the range): a burst of product pages trips Amazon's robot check, a
   * few spaced reads don't. Less traffic, never a way around the check.
   */
  linkSpacingMs: [number, number] = [3_000, 6_000];
  sleep = (ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms));

  /**
   * Watched links (see `WatchedLink`): each ASIN's product page, read
   * with the same {@link fetchPrice} as collected deals.
   */
  async collect(
    products: ProductRef[],
    context?: DiscoverContext,
  ): Promise<RawDeal[]> {
    const asins = products.filter((product) =>
      /^[A-Z0-9]{10}$/.test(product.externalId ?? ""),
    );
    // Amazon's robot check, once seen, answers the next requests too:
    // the remaining products wait for the next run (never retried around).
    let robotCheck = false;
    const ROBOT = "vérification anti-robot d'Amazon";
    let read = 0;
    return readProductPages(
      asins,
      async (page, product): Promise<RawDeal | undefined> => {
        const asin = product.externalId as string;
        if (robotCheck) {
          context?.blocked?.(asin, ROBOT);
          return undefined;
        }
        // Spaced out, one at a time (`linkSpacingMs`).
        if (read++ > 0) {
          const [min, max] = this.linkSpacingMs;
          await this.sleep(min + Math.random() * (max - min));
          if (robotCheck) {
            context?.blocked?.(asin, ROBOT);
            return undefined;
          }
        }
        const url = `https://www.amazon.fr/dp/${asin}`;
        // Same order as a run: a plain request first, the browser after.
        const fetched =
          this.fetchFirst && !this.getCloudflareBinding?.()
            ? await fetchAmazonProductPage(url)
            : { robotCheck: false };
        if (fetched.robotCheck) {
          robotCheck = true;
          context?.blocked?.(asin, ROBOT);
          return undefined;
        }
        const priced = fetched.product ?? (await this.fetchPrice(page, url));
        if (!priced) {
          if (await isRobotCheckPage(page)) {
            robotCheck = true;
            context?.blocked?.(asin, ROBOT);
          }
          return undefined;
        }
        return amazonRawDeal(asin, priced, product);
      },
      {
        // One at a time: the spacing above only means something then.
        concurrency: 1,
        cloudflareBinding: this.getCloudflareBinding?.(),
        context,
      },
    );
  }

  async discover(context?: DiscoverContext): Promise<RawDeal[]> {
    const startedAt = Date.now();
    const loadAtStart = currentLoad();
    return withBrowser(async (browser) => {
      type Card = {
        asin: string;
        url: string;
        title: string;
        imageUrl: string | null;
        categoryHint?: string;
        /** The card's "-xx %" badge, when it shows one. */
        badgePercent?: number;
        /** The card's current price ("Prix Flash: 79,99 €"), when shown. */
        cardPrice?: number;
      };
      // One list per collection page, interleaved below so every category
      // gets its share of `limit` (see `interleave`).
      const cardsPerPage: Card[][] = [];

      // Why a listing or product page gave nothing, noted once per run:
      // these failures are skipped on purpose, and were silent (2026-11-10,
      // 12 of 13 product pages « Page crashed » with nothing in the log).
      const failures = new Map<string, number>();
      const countFailure = (reason: string) =>
        failures.set(reason, (failures.get(reason) ?? 0) + 1);
      // Listing pages a few at a time too (each in its own context).
      let pagesRead = 0;
      const perPage = await mapWithConcurrency(
        this.dealsUrls,
        LISTING_CONCURRENCY,
        async (dealsUrl): Promise<Card[]> => {
          context?.progress?.(
            "Lecture des pages bons plans",
            ++pagesRead,
            this.dealsUrls.length,
          );
          // `/deals?bubble-id=deals-collection-toys` → "amazon:toys": the
          // collection is Amazon's own category for every card on it.
          const collection = dealsUrl.match(
            /deals-collection-([a-z0-9-]+)/,
          )?.[1];
          const categoryHint = collection ? `amazon:${collection}` : undefined;
          try {
            const cards = await withDeadline(
              withPage(browser, async (page) => {
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
                        document.querySelectorAll(
                          '[data-testid="product-card"]',
                        ),
                      ).map((el) => {
                        const link = el.querySelector(
                          'a[data-testid="product-card-link"]',
                        ) as HTMLAnchorElement | null;
                        const img = el.querySelector(
                          "img",
                        ) as HTMLImageElement | null;
                        const badge = (el as HTMLElement).innerText.match(
                          /-\s?(\d{1,2})\s?%/,
                        );
                        return {
                          asin: el.getAttribute("data-asin"),
                          url: link?.href ?? null,
                          title: img?.alt || null,
                          imageUrl: img?.src || null,
                          badgePercent: badge ? Number(badge[1]) : null,
                          priceText:
                            (el as HTMLElement).innerText.match(
                              /Prix[^:\n]*:\s*([\d\s.]+,\d{2})\s?€/,
                            )?.[1] ?? null,
                        };
                      }),
                    ),
                  (card) => card.asin,
                  // Deep enough for a 200-page cap shared across ~15
                  // collections once the "-20 %" card filter has run.
                  { rounds: 10 },
                );
              }),
              LISTING_PAGE_DEADLINE_MS,
              "page bons plans",
            );

            return cards
              .filter((card) => card.asin && card.url && card.title)
              .map((card) => ({
                asin: card.asin as string,
                url: card.url as string,
                title: card.title as string,
                imageUrl: card.imageUrl,
                categoryHint,
                badgePercent: card.badgePercent ?? undefined,
                cardPrice: card.priceText
                  ? parsePriceFr(card.priceText)
                  : undefined,
              }));
          } catch (error) {
            // One listing page failing (challenge, layout change, timeout)
            // must not block the other entry points from contributing cards.
            countFailure(`liste : ${failureReason(error)}`);
            return [];
          }
        },
      );
      cardsPerPage.push(...perPage);

      const deals: RawDeal[] = [];
      // Titles that already disqualify an offer (low-end laptop…) never
      // cost a product-page load.
      // Same for a small announced discount: the badge is measured against
      // the struck price, which is never below the real reference, so a
      // "-12 %" card can't turn into a real -20 % on its product page.
      const candidates = interleave(cardsPerPage, (card) => card.asin)
        .filter((card) => context?.worthFetching?.(card.title) ?? true)
        .filter(
          (card) =>
            card.badgePercent === undefined ||
            card.badgePercent >= MIN_BADGE_PERCENT,
        )
        .slice(0, this.limit);
      // A few product pages at once (each in its own context, see
      // below) instead of one by one: the bulk of a run's time.
      let done = 0;
      let byFetch = 0;
      let skipped = 0;
      const listingMs = Date.now() - startedAt;
      const pageTimes: number[] = [];
      const pagesStartedAt = Date.now();
      const found = await mapWithConcurrency(
        candidates,
        PAGE_CONCURRENCY,
        async (card): Promise<RawDeal | undefined> => {
          const pageStartedAt = Date.now();
          try {
            // Known deal, fresh details, same price as on its card: nothing
            // a product page could add. Still reported, so it stays "seen"
            // (the service keeps the stored details, struck price and text).
            if (
              card.cardPrice !== undefined &&
              context?.isUnchanged?.(card.asin, card.cardPrice)
            ) {
              skipped++;
              return {
                externalId: card.asin,
                title: card.title,
                url: card.url.split("?")[0],
                imageUrl: upscaleAmazonImage(card.imageUrl ?? undefined),
                price: card.cardPrice,
                currency: "EUR",
                availability: "in_stock",
                merchantId: "amazon",
                categoryHint: card.categoryHint,
              };
            }
            // Each product page is fetched in its own browser context: Amazon
            // fingerprints sessions, and reusing cookies/context across
            // several sequential product-page loads causes later ones to
            // come back with the price element silently missing.
            let priced =
              this.fetchFirst && !this.getCloudflareBinding?.()
                ? await fetchAmazonProduct(card.url)
                : undefined;
            if (priced) {
              byFetch++;
            } else {
              priced = await withDeadline(
                withPage(browser, (page) => this.fetchPrice(page, card.url)),
                PRODUCT_PAGE_DEADLINE_MS,
                "fiche produit",
              );
            }
            if (!priced) {
              countFailure("fiche : prix introuvable");
              return undefined;
            }

            return {
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
              // Collection first; the product page breadcrumb covers cards
              // only found in generic lists (all deals, lightning deals).
              categoryHint:
                card.categoryHint ??
                (priced.breadcrumb
                  ? `amazon-crumb:${priced.breadcrumb}`
                  : undefined),
              // Read on the product page we open anyway for the price: no
              // extra request, so always fresh (no DiscoverContext needed).
              details: priced.details,
            };
          } catch (error) {
            // One product page failing (challenge, layout change, timeout)
            // must not block the rest of the deals found this run.
            countFailure(`fiche : ${failureReason(error)}`);
            return undefined;
          } finally {
            pageTimes.push(Date.now() - pageStartedAt);
            context?.progress?.(
              "Fiches produits (prix, vendeur, avis)",
              ++done,
              candidates.length,
            );
          }
        },
      );
      deals.push(...found.filter((deal): deal is RawDeal => !!deal));
      const emptyListings = perPage.filter(
        (cards) => cards.length === 0,
      ).length;
      if (failures.size > 0 || emptyListings > 0) {
        context?.note?.(
          formatAmazonFailures({
            listings: this.dealsUrls.length,
            emptyListings,
            candidates: candidates.length,
            failures,
          }),
        );
      }

      noteTiming(this.id, {
        listingMs,
        pagesMs: Date.now() - pagesStartedAt,
        candidates: candidates.length,
        pagesRead: deals.length,
        pagesFailed: candidates.length - deals.length,
        readByFetch: byFetch,
        skippedUnchanged: skipped,
        pageP50Ms: percentile(pageTimes, 0.5),
        pageP95Ms: percentile(pageTimes, 0.95),
        load: [loadAtStart, currentLoad()],
      });
      return deals;
    }, this.getCloudflareBinding?.());
  }

  /** Reads one product page: price, struck price, seller, reviews… */
  async fetchPrice(
    page: DealsPage,
    url: string,
  ): Promise<
    | {
        price: number;
        listPrice?: number;
        description?: string;
        details?: DealDetails;
        /** Root of the product's breadcrumb, e.g. "Cuisine et Maison". */
        breadcrumb?: string;
        /** `#productTitle`, for a product not found on a listing card. */
        title?: string;
        imageUrl?: string;
      }
    | undefined
  > {
    const response = await page.goto(url, {
      waitUntil: "domcontentloaded",
      // Generous: several pages load at once during a run.
      timeout: 25_000,
    });
    if (!response || !response.ok()) {
      return undefined;
    }

    await page
      .waitForSelector(PRICE_SELECTORS.join(", "), { timeout: 12_000 })
      .catch(() => {
        // No price container showed up: the evaluate() below returns
        // undefined and this candidate is simply skipped.
      });

    const [texts, bullets, pageText] = await Promise.all([
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
      this.fetchPageText(page),
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
    // Same reader as the plain-fetch path, on the rendered page.
    const facts = page.content
      ? await page
          .content()
          .then(parseAmazonFacts)
          .catch(() => undefined)
      : undefined;

    return {
      price,
      listPrice:
        listPrice !== undefined && listPrice > price ? listPrice : undefined,
      description: bullets,
      details: { ...parseAmazonSignals(pageText, price), facts },
      title: pageText.title,
      ...(await page.evaluate(() => {
        const image = document.querySelector(
          "#landingImage, #imgBlkFront",
        ) as HTMLImageElement | null;
        return {
          breadcrumb:
            document
              .querySelector("#wayfinding-breadcrumbs_feature_div li a")
              ?.textContent?.replace(/\s+/g, " ")
              .trim() || undefined,
          imageUrl:
            image?.getAttribute("data-old-hires") || image?.src || undefined,
        };
      })),
    };
  }

  /**
   * The raw strings behind {@link parseAmazonSignals}: seller/shipper,
   * rating, review count, "other sellers" line, purchases last month, and
   * the price column's text — which carries the "Prix le plus bas des 30
   * derniers jours" Amazon must display next to any announced reduction.
   * `innerText`, not `textContent`: the price column embeds `<style>`
   * blocks whose CSS would otherwise pollute every regex.
   */
  protected fetchPageText(page: DealsPage): Promise<AmazonPageText> {
    return page.evaluate(() => {
      const text = (selector: string) =>
        (document.querySelector(selector) as HTMLElement | null)?.innerText
          ?.replace(/\s+/g, " ")
          .trim() || undefined;
      return {
        title: text("#productTitle") ?? document.title,
        priceArea:
          text("#apex_desktop") ??
          text("#corePriceDisplay_desktop_feature_div") ??
          text("#corePrice_feature_div") ??
          "",
        ratingText:
          document.querySelector("#acrPopover")?.getAttribute("title") ??
          text("#acrPopover"),
        reviewsText: text("#acrCustomerReviewText"),
        sellerText: text(
          "#merchantInfoFeature_feature_div .offer-display-feature-text-message",
        ),
        shipperText: text(
          "#fulfillerInfoFeature_feature_div .offer-display-feature-text-message",
        ),
        buyBoxText: text("#offerDisplayFeatures_desktop"),
        otherSellersText:
          text("#dynamic-aod-ingress-box") ??
          text("#olpLinkWidget_feature_div"),
        boughtText: text("#social-proofing-faceout-title-tk_bought"),
        basisText: text(".basisPrice"),
      };
    });
  }

  /** See {@link readAmazonBullets}. */
  protected fetchFeatureBullets(page: DealsPage): Promise<string | undefined> {
    return readAmazonBullets(page);
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

/**
 * Amazon's "À propos de cet article" bullet list (`#feature-bullets`) is
 * real, merchant-written product info — what the item actually is and
 * does. Hidden bullets (`.aok-hidden`, SEO-only filler Amazon doesn't
 * display) are skipped; falls back to the short product description
 * paragraph. Capped to a few bullets: it ends up in a Dealabs post. Shared
 * with `MarketReferenceService`, which borrows it to describe a Cdiscount
 * product matched on Amazon by EAN.
 */
export async function readAmazonBullets(
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

/** A page failure in a few French words, for the run's note. */
export function failureReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/Page crashed|Target crashed/i.test(message)) return "page plantée";
  if (/captcha|robot/i.test(message)) return "vérification anti-robot";
  if (/Timeout|timed out/i.test(message)) return "délai dépassé";
  const status = message.match(/returned (\d{3})/)?.[1];
  if (status) return `réponse ${status}`;
  return message.replace(/\s+/g, " ").trim().slice(0, 60) || "erreur";
}

/** « Amazon : 13 listes (2 vides), 12 fiche(s) sans résultat sur 13 — … » */
export function formatAmazonFailures(run: {
  listings: number;
  emptyListings: number;
  candidates: number;
  failures: Map<string, number>;
}): string {
  const product = [...run.failures.entries()].filter(([reason]) =>
    reason.startsWith("fiche"),
  );
  const failedProducts = product.reduce((sum, [, n]) => sum + n, 0);
  const reasons = [...run.failures.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([reason, n]) => `${reason} ×${n}`)
    .join(", ");
  return (
    `Amazon : ${run.listings} liste(s) (${run.emptyListings} vide(s)), ` +
    `${failedProducts} fiche(s) sans résultat sur ${run.candidates}` +
    (reasons ? ` — ${reasons}` : "")
  );
}
