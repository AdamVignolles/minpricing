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
import { DealabsDraftService } from "./DealabsDraftService.ts";
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

  /**
   * Deal-page URLs to auto-discover from. Overridable per environment since
   * these are real merchant pages scraped with a headless browser — see
   * {@link AmazonCollector} / {@link CdiscountCollector} for why a browser
   * is required and what happens when their markup changes.
   */
  protected env = $env(
    z.object({
      AMAZON_DEALS_URL: z.text({
        default: "https://www.amazon.fr/deals",
      }),
      CDISCOUNT_HOME_URL: z.text({
        default: "https://www.cdiscount.com/",
      }),
    }),
  );

  protected readonly collectorsById: Record<string, DealSource> = {
    manual: new ManualCollector(),
    steam: new SteamCollector(),
    amazon: new AmazonCollector(
      this.env.AMAZON_DEALS_URL,
      undefined,
      this.cloudflareBrowserBinding(),
    ),
    cdiscount: new CdiscountCollector(
      this.env.CDISCOUNT_HOME_URL,
      undefined,
      this.cloudflareBrowserBinding(),
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

    const discountPercentage =
      existing && existing.currentPrice > 0
        ? Math.round(
            ((existing.currentPrice - rawDeal.price) / existing.currentPrice) *
              100,
          )
        : undefined;

    const dealId = existing
      ? existing.id
      : (
          await this.deals.create({
            sourceId,
            externalId: rawDeal.externalId,
            title: rawDeal.title,
            url: rawDeal.url,
            imageUrl: rawDeal.imageUrl,
            merchantId: rawDeal.merchantId,
            categoryId: rawDeal.categoryId,
            currentPrice: rawDeal.price,
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
        currentPrice: rawDeal.price,
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

    const stats = await this.pricing.getStats(dealId, rawDeal.price);
    const score = this.scoring.computeScore(stats, sourceType);
    await this.deals.updateById(dealId, { score });

    const deal = await this.deals.getById(dealId);
    await this.drafts.maybeGenerateDraft(deal, stats);

    return !existing;
  }
}
