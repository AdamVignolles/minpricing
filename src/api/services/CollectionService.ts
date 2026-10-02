import { $env, $inject, Alepha, z } from "alepha";
import { DateTimeProvider } from "alepha/datetime";
import { $logger } from "alepha/logger";
import { $repository } from "alepha/orm";

import { AmazonCollector } from "../collectors/AmazonCollector.ts";
import type { CloudflareBrowserBinding } from "../collectors/browser.ts";
import { CdiscountCollector } from "../collectors/CdiscountCollector.ts";
import type { DealSource, RawDeal } from "../collectors/DealSource.ts";
import { ManualCollector } from "../collectors/ManualCollector.ts";
import { SteamCollector } from "../collectors/SteamCollector.ts";
import { dealEntity } from "../entities/Deal.ts";
import { sourceEntity } from "../entities/Source.ts";
import { trackedProductEntity } from "../entities/TrackedProduct.ts";
import { CategorizationService } from "./CategorizationService.ts";
import { DealabsDraftService } from "./DealabsDraftService.ts";
import { DEFAULT_MERCHANT_BY_SOURCE } from "./DealTypes.ts";
import { IdealoReferenceService } from "./IdealoReferenceService.ts";
import { PricingService } from "./PricingService.ts";
import { ScoringService, type SourceReliability } from "./ScoringService.ts";

export interface CollectionSummary {
  sourceId: string;
  collected: number;
  created: number;
  updated: number;
  error?: string;
}

/**
 * Splits a comma-separated env value into a list of trimmed, non-empty
 * URLs. See {@link CollectionService.env}'s doc for why these accept
 * several entries.
 */
function splitUrls(value: string): string[] {
  return value
    .split(",")
    .map((url) => url.trim())
    .filter((url) => url.length > 0);
}

/**
 * Orchestrates one collection run: for every enabled source, run its
 * collector — either over its tracked products (`collect`) or fully
 * autonomously (`discover`) — then normalize/dedupe/record price
 * history/score/draft each resulting offer.
 *
 * One failing source never blocks the others.
 */
export class CollectionService {
  protected log = $logger();
  protected alepha = $inject(Alepha);
  protected dateTime = $inject(DateTimeProvider);

  protected sources = $repository(sourceEntity);
  protected trackedProducts = $repository(trackedProductEntity);
  protected deals = $repository(dealEntity);

  protected pricing = $inject(PricingService);
  protected scoring = $inject(ScoringService);
  protected drafts = $inject(DealabsDraftService);
  protected categorization = $inject(CategorizationService);
  protected idealoReference = $inject(IdealoReferenceService);

  /**
   * Fallback merchant for sources that discover offers on a single
   * merchant's own site. Without it every auto-discovered deal landed with
   * `merchantId = null` and the merchant filter matched nothing.
   */
  protected readonly defaultMerchantBySource = DEFAULT_MERCHANT_BY_SOURCE;

  /**
   * Deal-page URLs to auto-discover from. Overridable per environment since
   * these are real merchant pages scraped with a headless browser — see
   * {@link AmazonCollector} / {@link CdiscountCollector} for why a browser
   * is required and what happens when their markup changes.
   *
   * Accepts a comma-separated list: every URL is visited and its cards are
   * merged (de-duplicated by ASIN/URL) before any product page is opened,
   * so adding another category/listing page here is the main way to widen
   * how many candidates a run actually considers — e.g.
   * `AMAZON_DEALS_URL=https://www.amazon.fr/deals,https://www.amazon.fr/gp/goldbox`.
   *
   * `*_LIMIT` caps how many of the merged/de-duplicated candidates are
   * actually turned into deals (Amazon opens one product page per
   * candidate to read its price, so this is also the number of extra
   * requests a run makes — raise it gradually and watch for an uptick in
   * challenge/block responses rather than jumping straight to a huge
   * number).
   */
  protected env = $env(
    z.object({
      AMAZON_DEALS_URL: z.text({
        default: "https://www.amazon.fr/deals",
      }),
      AMAZON_DEALS_LIMIT: z.number().default(40),
      CDISCOUNT_HOME_URL: z.text({
        // Homepage's "Bons plans" carousel is thin (~8 static cards,
        // confirmed not virtualized — scrolling never grows it) so the
        // dedicated soldes/promos listing page is included by default
        // too: it lazy-loads a bigger batch (~32 cards) on first scroll.
        // No further pagination was found for it (no `?page=` support,
        // no "next" control, no facet links) — 32 is its real ceiling.
        default:
          "https://www.cdiscount.com/,https://www.cdiscount.com/soldes-promotions/v-14107-14107.html",
      }),
      CDISCOUNT_DEALS_LIMIT: z.number().default(60),
    }),
  );

  protected readonly collectorsById: Record<string, DealSource> = {
    manual: new ManualCollector(),
    steam: new SteamCollector(),
    amazon: new AmazonCollector(
      splitUrls(this.env.AMAZON_DEALS_URL),
      this.env.AMAZON_DEALS_LIMIT,
      () => this.cloudflareBrowserBinding(),
    ),
    cdiscount: new CdiscountCollector(
      splitUrls(this.env.CDISCOUNT_HOME_URL),
      this.env.CDISCOUNT_DEALS_LIMIT,
      () => this.cloudflareBrowserBinding(),
    ),
  };

  /**
   * On Cloudflare Workers, Amazon/Cdiscount's Playwright-based collectors
   * launch through the "Browser Rendering" binding instead (no process
   * spawning allowed on Workers) — see `browser.ts`. `undefined` locally /
   * on a plain Node server, which keeps them on local Playwright.
   */
  protected cloudflareBrowserBinding(): CloudflareBrowserBinding | undefined {
    if (!this.alepha.isServerless()) {
      return undefined;
    }
    const cloudflareEnv = this.alepha.get("cloudflare.env") as
      | Record<string, unknown>
      | undefined;
    return cloudflareEnv?.BROWSER as CloudflareBrowserBinding | undefined;
  }

  async runAll(): Promise<CollectionSummary[]> {
    const sources = await this.sources.findMany({
      where: { enabled: { eq: true } },
    });

    const summaries: CollectionSummary[] = [];
    for (const source of sources) {
      summaries.push(await this.runOne(source.id));
    }
    return summaries;
  }

  async runOne(sourceId: string): Promise<CollectionSummary> {
    const source = await this.sources.getById(sourceId);
    const collector = this.collectorsById[source.id];
    const now = this.dateTime.nowISOString();

    if (!collector) {
      await this.sources.updateById(source.id, {
        lastRunAt: now,
        lastErrorAt: now,
        lastError: `No collector registered for source "${source.id}"`,
      });
      return {
        sourceId: source.id,
        collected: 0,
        created: 0,
        updated: 0,
        error: "no-collector",
      };
    }

    const products = await this.trackedProducts.findMany({
      where: {
        and: [{ sourceId: { eq: source.id } }, { enabled: { eq: true } }],
      },
    });

    try {
      const rawDeals: RawDeal[] = [];
      if (collector.collect) {
        rawDeals.push(...(await collector.collect(products)));
      }
      if (collector.discover) {
        rawDeals.push(...(await collector.discover()));
      }

      let created = 0;
      let updated = 0;
      for (const rawDeal of rawDeals) {
        const wasCreated = await this.upsertDeal(
          source.id,
          source.type,
          rawDeal,
        );
        if (wasCreated) {
          created++;
        } else {
          updated++;
        }
      }

      await this.sources.updateById(source.id, {
        lastRunAt: now,
        lastSuccessAt: now,
        lastError: undefined,
      });

      return {
        sourceId: source.id,
        collected: rawDeals.length,
        created,
        updated,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.error(`Collection failed for source "${source.id}": ${message}`);
      await this.sources.updateById(source.id, {
        lastRunAt: now,
        lastErrorAt: now,
        lastError: message,
      });
      return {
        sourceId: source.id,
        collected: 0,
        created: 0,
        updated: 0,
        error: message,
      };
    }
  }

  /**
   * Looks up the tracked product behind this offer (only set for
   * `collect()`-sourced deals — manual/Steam, not Amazon/Cdiscount's
   * auto-discovery, which never had one to begin with) and, if it has an
   * `idealoUrl` configured, its external market reference price alongside
   * that URL (denormalized onto `Deal.idealoUrl` so the detail page can
   * fetch the full history on demand without a reverse lookup).
   */
  protected async resolveIdealoReference(
    productId?: string,
  ): Promise<{ referencePrice?: number; idealoUrl?: string }> {
    if (!productId) {
      return {};
    }
    const product = await this.trackedProducts.findOne({
      where: { id: { eq: productId } },
    });
    if (!product) {
      return {};
    }
    const referencePrice = await this.idealoReference.getReferencePrice(
      product,
      () => this.cloudflareBrowserBinding(),
    );
    return { referencePrice, idealoUrl: product.idealoUrl };
  }

  /**
   * @returns true if a new deal was created, false if an existing one was updated.
   */
  protected async upsertDeal(
    sourceId: string,
    sourceType: SourceReliability,
    rawDeal: RawDeal,
  ): Promise<boolean> {
    const now = this.dateTime.nowISOString();

    const existing = await this.deals.findOne({
      where: {
        and: [
          { sourceId: { eq: sourceId } },
          { externalId: { eq: rawDeal.externalId } },
        ],
      },
    });

    // The merchant's own reference price is what a shopper compares
    // against, so that is what drives the badge. `oldPrice` (the price we
    // saw on the previous run) is kept as a separate signal: it is almost
    // always equal to the current one, which is exactly why using it here
    // made every deal render as "-0%".
    const listPrice =
      rawDeal.listPrice !== undefined && rawDeal.listPrice > rawDeal.price
        ? rawDeal.listPrice
        : undefined;

    const discountPercentage =
      listPrice !== undefined
        ? Math.round(((listPrice - rawDeal.price) / listPrice) * 100)
        : undefined;

    const merchantId =
      rawDeal.merchantId ?? this.defaultMerchantBySource[sourceId];
    const categoryId =
      rawDeal.categoryId ?? this.categorization.classify(rawDeal.title);

    const dealId = existing
      ? existing.id
      : (
          await this.deals.create({
            sourceId,
            externalId: rawDeal.externalId,
            title: rawDeal.title,
            url: rawDeal.url,
            imageUrl: rawDeal.imageUrl,
            description: rawDeal.description,
            merchantId,
            categoryId,
            currentPrice: rawDeal.price,
            listPrice,
            discountPercentage,
            currency: rawDeal.currency,
            availability: rawDeal.availability ?? "unknown",
            firstSeenAt: now,
            lastSeenAt: now,
            status: "active",
          })
        ).id;

    if (existing) {
      await this.deals.updateById(existing.id, {
        title: rawDeal.title,
        url: rawDeal.url,
        imageUrl: rawDeal.imageUrl,
        // Keep the last description we managed to scrape rather than
        // blanking it out on a run that couldn't get one (e.g. the
        // product page briefly failed to load).
        description: rawDeal.description ?? existing.description,
        merchantId,
        categoryId,
        currentPrice: rawDeal.price,
        listPrice,
        oldPrice: existing.currentPrice,
        currency: rawDeal.currency,
        discountPercentage,
        availability: rawDeal.availability ?? "unknown",
        lastSeenAt: now,
        status: "active",
      });
    }

    await this.pricing.recordObservation(
      dealId,
      rawDeal.price,
      rawDeal.currency,
      sourceId,
    );

    const { referencePrice, idealoUrl } = await this.resolveIdealoReference(
      rawDeal.productId,
    );
    const stats = await this.pricing.getStats(
      dealId,
      rawDeal.price,
      referencePrice,
    );
    const score = this.scoring.computeScore(stats, sourceType);
    await this.deals.updateById(dealId, { score, referencePrice, idealoUrl });

    const deal = await this.deals.getById(dealId);
    await this.drafts.maybeGenerateDraft(deal, stats);

    return !existing;
  }
}
