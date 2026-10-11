import { $env, $inject, Alepha, z } from "alepha";
import { DateTimeProvider } from "alepha/datetime";
import { $logger } from "alepha/logger";
import { $repository } from "alepha/orm";

import { AmazonCollector } from "../collectors/AmazonCollector.ts";
import type { CloudflareBrowserBinding } from "../collectors/browser.ts";
import { CdiscountCollector } from "../collectors/CdiscountCollector.ts";
import type {
  DealSource,
  DiscoverContext,
  RawDeal,
} from "../collectors/DealSource.ts";
import { ManualCollector } from "../collectors/ManualCollector.ts";
import { SteamCollector } from "../collectors/SteamCollector.ts";
import { dealEntity } from "../entities/Deal.ts";
import { sourceEntity } from "../entities/Source.ts";
import { trackedProductEntity } from "../entities/TrackedProduct.ts";
import { CategorizationService } from "./CategorizationService.ts";
import { CollectionProgressService } from "./CollectionProgressService.ts";
import { DealabsDraftService } from "./DealabsDraftService.ts";
import { DealabsHistoryService } from "./DealabsHistoryService.ts";
import { DEFAULT_MERCHANT_BY_SOURCE } from "./DealTypes.ts";
import { IdealoReferenceService } from "./IdealoReferenceService.ts";
import { ItadService } from "./ItadService.ts";
import { MarketReferenceService } from "./MarketReferenceService.ts";
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
  protected marketReference = $inject(MarketReferenceService);
  protected dealabsHistory = $inject(DealabsHistoryService);
  protected itad = $inject(ItadService);
  protected progress = $inject(CollectionProgressService);

  /**
   * How long a deal's seller/review details are reused before the
   * collector re-reads them from the product page. See
   * {@link DiscoverContext}.
   */
  protected static readonly DETAILS_TTL_MS = 24 * 60 * 60 * 1000;

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
        // The generic deals page is mostly high-tech; Amazon's own
        // per-category deal collections (`?bubble-id=…`, measured to work
        // as plain URLs) bring in home, garden, toys, beauty, fashion,
        // sport… Each collection also tells us the deal's category.
        default: [
          "https://www.amazon.fr/deals",
          ...[
            "home-and-kitchen",
            "toys",
            "lawn-and-garden",
            "beauty",
            "fashion",
            "sports-and-outdoors",
            "baby",
            "automotive",
            "animalerie",
            "grocery",
            "video-games-and-accessories",
            "computing-and-software",
            "tv-and-home-cinema",
          ].map(
            (collection) =>
              `https://www.amazon.fr/deals?bubble-id=deals-collection-${collection}`,
          ),
        ].join(","),
      }),
      // Product pages opened per run (each one is a request Amazon may
      // flag): shared round-robin across the collections above.
      AMAZON_DEALS_LIMIT: z.number().default(60),
      CDISCOUNT_HOME_URL: z.text({
        // Homepage "Bons plans" carousel (~8 cards) and the soldes page
        // (~32 cards, no pagination), plus Cdiscount's category hubs —
        // measured 8-31 offers each, half or more marked as promotions.
        default: [
          "https://www.cdiscount.com/",
          "https://www.cdiscount.com/soldes-promotions/v-14107-14107.html",
          "https://www.cdiscount.com/maison/v-117-0.html",
          "https://www.cdiscount.com/jardin/v-163-0.html",
          "https://www.cdiscount.com/bricolage/v-166-0.html",
          "https://www.cdiscount.com/juniors/jeux-et-jouets-par-type/v-12006-12006.html",
          "https://www.cdiscount.com/pret-a-porter/bebe-puericulture/v-11317-11317.html",
          "https://www.cdiscount.com/le-sport/v-121-0.html",
          "https://www.cdiscount.com/mode/v-113-5.html",
          "https://www.cdiscount.com/au-quotidien/hygiene-soin-beaute/v-12702-12702.html",
          "https://www.cdiscount.com/electromenager/v-110-0.html",
          "https://www.cdiscount.com/auto/v-133-0.html",
          "https://www.cdiscount.com/vin-alimentaire/v-127-1.html",
        ].join(","),
      }),
      CDISCOUNT_DEALS_LIMIT: z.number().default(90),
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
    // Two overlapping runs doubled every page load (and Amazon's suspicion)
    // for nothing: the cron tick and a manual "collect now" now skip while
    // another run is still going, wherever it runs.
    if (await this.progress.isRunning()) {
      this.log.warn("Collection already running: this run is skipped.");
      return [];
    }

    const sources = await this.sources.findMany({
      where: { enabled: { eq: true } },
    });
    await this.progress.start(
      sources.map((source) => ({ id: source.id, name: source.name })),
    );

    const summaries: CollectionSummary[] = [];
    try {
      for (const source of sources) {
        await this.progress.sourceStarted(source.id);
        const summary = await this.runOne(source.id);
        summaries.push(summary);
        await this.progress.sourceFinished(source.id, summary);
      }
    } catch (error) {
      await this.progress.finish(true);
      throw error;
    }
    await this.progress.finish();
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
      const context = await this.discoverContext(source.id);
      const step = (label: string, done?: number, total?: number) =>
        this.progress.step(source.id, label, done, total);
      const rawDeals: RawDeal[] = [];
      if (collector.collect) {
        rawDeals.push(...(await collector.collect(products, context)));
      }
      if (collector.discover) {
        rawDeals.push(...(await collector.discover(context)));
      }

      let created = 0;
      let updated = 0;
      for (const [index, rawDeal] of rawDeals.entries()) {
        step(
          "Enregistrement et notation des offres",
          index + 1,
          rawDeals.length,
        );
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

      // Cross-merchant check (same EAN elsewhere), then rescore whatever
      // it touched. After the upserts, so a brand-new deal's EAN is already
      // stored and can be looked up in this very run.
      // Same for the price-history references: past Dealabs deals (every
      // product) and IsThereAnyDeal's all-time low (Steam, with a key).
      const checked = new Set([
        ...(await this.marketReference.refreshStale(
          source.id,
          () => this.cloudflareBrowserBinding(),
          (done, total) => step("Comparaison avec Amazon (EAN)", done, total),
        )),
        ...(await this.dealabsHistory.refreshStale(source.id, (done, total) =>
          step("Historique des bons plans Dealabs", done, total),
        )),
        ...(await this.itad.refreshStale(source.id, (done, total) =>
          step("Plus bas historique (IsThereAnyDeal)", done, total),
        )),
      ]);
      for (const [index, dealId] of [...checked].entries()) {
        step("Mise à jour des notes", index + 1, checked.size);
        await this.rescore(dealId, source.type);
      }

      await this.sources.updateById(source.id, {
        lastRunAt: now,
        lastSuccessAt: now,
        // Empty, not `undefined`: the ORM skips undefined fields, so the
        // previous run's error used to stay on screen after a success.
        lastError: "",
      });

      return {
        sourceId: source.id,
        collected: rawDeals.length,
        created,
        updated,
      };
    } catch (error) {
      const fullMessage =
        error instanceof Error ? error.message : String(error);
      this.log.error(
        `Collection failed for source "${source.id}": ${fullMessage}`,
      );
      // `z.text()` caps at 255 chars, and browser errors (Playwright's
      // "Executable doesn't exist…" banner, call logs) are far longer and
      // multi-line. Storing them verbatim made the write itself throw, which
      // turned a single failing source into a 500 for the whole run and hid
      // the real cause. The full text stays in the log above.
      const message = this.truncateError(fullMessage);
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
   * Tells collectors which offers already have fresh details, so they
   * only open product pages for new or stale ones.
   */
  protected async discoverContext(sourceId: string): Promise<DiscoverContext> {
    const rows = await this.deals.findMany({
      where: { sourceId: { eq: sourceId } },
    });
    const now = Date.now();
    const fresh = new Set(
      rows
        .filter(
          (deal) =>
            deal.detailsCheckedAt &&
            now - new Date(deal.detailsCheckedAt).getTime() <
              CollectionService.DETAILS_TTL_MS &&
            // No description yet (e.g. read before descriptions were
            // extracted): re-read now rather than waiting out the 24 h.
            !!deal.description?.trim(),
        )
        .map((deal) => deal.externalId),
    );
    return {
      needsDetails: (externalId) => !fresh.has(externalId),
      progress: (step, done, total) =>
        this.progress.step(sourceId, step, done, total),
    };
  }

  /**
   * Recomputes and stores a deal's score from what is stored about it —
   * shared by the upsert path and the post-run market check, so both
   * always score with exactly the same inputs.
   */
  protected async rescore(
    dealId: string,
    sourceType: SourceReliability,
  ): Promise<void> {
    const deal = await this.deals.getById(dealId);
    const stats = await this.pricing.getStats(
      deal.id,
      deal.currentPrice,
      deal.referencePrice,
    );
    const { score } = this.scoring.evaluate(deal, stats, sourceType);
    await this.deals.updateById(deal.id, { score });
  }

  /** Collapses whitespace and fits an error message in `Source.lastError`. */
  protected truncateError(message: string, max = 255): string {
    const flat = message.replace(/\s+/g, " ").trim();
    return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
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
    // Some sources only read the struck price on the product page, which
    // is skipped while details are fresh — keep the stored one then,
    // rather than flip-flopping the badge between runs.
    const keptListPrice =
      !rawDeal.details &&
      existing?.listPrice !== undefined &&
      existing.listPrice > rawDeal.price
        ? existing.listPrice
        : undefined;
    const listPrice =
      rawDeal.listPrice !== undefined && rawDeal.listPrice > rawDeal.price
        ? rawDeal.listPrice
        : keptListPrice;

    const discountPercentage =
      listPrice !== undefined
        ? Math.round(((listPrice - rawDeal.price) / listPrice) * 100)
        : undefined;

    const merchantId =
      rawDeal.merchantId ?? this.defaultMerchantBySource[sourceId];
    // Merchant's own classification first. Without one this run (e.g. an
    // Amazon offer only seen in the generic "all deals" list), keep what a
    // previous run's hint decided rather than downgrading to a title guess.
    const categoryId =
      rawDeal.categoryId ??
      this.categorization.fromHint(rawDeal.categoryHint) ??
      (existing?.categoryId && existing.categoryId !== "other"
        ? existing.categoryId
        : this.categorization.classify(rawDeal.title));

    // Only written when this run actually fetched details: a run that
    // skipped them (still fresh) must not blank out what was stored.
    const details = rawDeal.details
      ? {
          sellerName: rawDeal.details.sellerName,
          soldByMerchant: rawDeal.details.soldByMerchant,
          shippedByMerchant: rawDeal.details.shippedByMerchant,
          sellerRating: rawDeal.details.sellerRating,
          sellerSalesCount: rawDeal.details.sellerSalesCount,
          offersCount: rawDeal.details.offersCount,
          bestOtherOfferPrice: rawDeal.details.bestOtherOfferPrice,
          productRating: rawDeal.details.productRating,
          productReviewCount: rawDeal.details.productReviewCount,
          recentPurchases: rawDeal.details.recentPurchases,
          condition: rawDeal.details.condition,
          ean: rawDeal.details.ean,
          lowestRecentPrice: rawDeal.details.lowestRecentPrice,
          listPriceKind: rawDeal.details.listPriceKind,
          detailsCheckedAt: now,
        }
      : {};

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
            ...details,
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
        ...details,
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
    await this.deals.updateById(dealId, { referencePrice, idealoUrl });
    await this.rescore(dealId, sourceType);

    const deal = await this.deals.getById(dealId);
    await this.drafts.maybeGenerateDraft(deal);

    return !existing;
  }
}
