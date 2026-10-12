import { $hook, $inject } from "alepha";
import { $repository } from "alepha/orm";

import { categoryEntity } from "../entities/Category.ts";
import { dealEntity } from "../entities/Deal.ts";
import { merchantEntity } from "../entities/Merchant.ts";
import { sourceEntity } from "../entities/Source.ts";
import { CategorizationService } from "./CategorizationService.ts";
import { DEFAULT_MERCHANT_BY_SOURCE } from "./DealTypes.ts";

/**
 * Seeds the sources this MVP ships with, plus a couple of common
 * categories/merchants, so the app is usable right after `alepha dev`
 * without any manual SQL. Idempotent: skips anything that already exists.
 */
export class SeedService {
  protected sources = $repository(sourceEntity);
  protected categories = $repository(categoryEntity);
  protected merchants = $repository(merchantEntity);
  protected deals = $repository(dealEntity);
  protected categorization = $inject(CategorizationService);

  onReady = $hook({
    on: "ready",
    handler: async () => {
      await this.seedSources();
      await this.seedCategories();
      await this.seedMerchants();
      await this.backfillDealMetadata();
    },
  });

  protected async seedSources() {
    const defaults = [
      {
        id: "manual",
        name: "Saisie manuelle",
        type: "manual" as const,
      },
      { id: "steam", name: "Steam", type: "api" as const },
      {
        id: "amazon",
        name: "Amazon (bons plans, auto)",
        type: "scrape" as const,
      },
      {
        id: "cdiscount",
        name: "Cdiscount (bons plans, auto)",
        type: "scrape" as const,
      },
      {
        id: "aliexpress",
        name: "AliExpress (deals du jour)",
        type: "scrape" as const,
      },
      // Operators: their own pages / public API, read without a browser.
      {
        id: "orange",
        name: "Orange (forfaits & box)",
        type: "scrape" as const,
      },
      { id: "free", name: "Free Mobile (forfaits)", type: "scrape" as const },
      {
        id: "bouygues",
        name: "Bouygues Telecom & B&YOU (forfaits)",
        type: "api" as const,
      },
      { id: "sfr", name: "RED by SFR (forfaits)", type: "scrape" as const },
    ];

    for (const source of defaults) {
      const existing = await this.sources.findById(source.id);
      if (!existing) {
        await this.sources.create(source);
      }
    }
  }

  protected async seedCategories() {
    const defaults = [
      { id: "video-games", name: "Jeux vidéo", slug: "video-games" },
      { id: "computing", name: "Informatique", slug: "computing" },
      { id: "phones", name: "Téléphonie", slug: "phones" },
      { id: "audio", name: "Audio", slug: "audio" },
      { id: "tv-photo", name: "TV & Photo", slug: "tv-photo" },
      { id: "appliances", name: "Électroménager", slug: "appliances" },
      { id: "home", name: "Maison & Cuisine", slug: "home" },
      { id: "diy", name: "Bricolage & Jardin", slug: "diy" },
      { id: "kids", name: "Jouets & Bébé", slug: "kids" },
      { id: "sport", name: "Sport & Loisirs", slug: "sport" },
      { id: "food", name: "Épicerie & Boissons", slug: "food" },
      { id: "pets", name: "Animalerie", slug: "pets" },
      { id: "fashion", name: "Mode", slug: "fashion" },
      { id: "beauty-health", name: "Beauté & Santé", slug: "beauty-health" },
      { id: "auto", name: "Auto & Mobilité", slug: "auto" },
      { id: "telecom", name: "Forfaits & Box", slug: "telecom" },
      { id: "other", name: "Autre", slug: "other" },
    ];

    for (const category of defaults) {
      const existing = await this.categories.findById(category.id);
      if (!existing) {
        await this.categories.create(category);
      } else if (existing.name !== category.name) {
        // Seeded names are owned by the app (e.g. "Maison & Jardin" became
        // "Maison & Cuisine" when garden moved to "Bricolage & Jardin").
        await this.categories.updateById(category.id, { name: category.name });
      }
    }
  }

  protected async seedMerchants() {
    const defaults = [
      { id: "amazon", name: "Amazon", domain: "amazon.fr" },
      { id: "cdiscount", name: "Cdiscount", domain: "cdiscount.com" },
      { id: "steam", name: "Steam", domain: "store.steampowered.com" },
      { id: "aliexpress", name: "AliExpress", domain: "aliexpress.com" },
      { id: "orange", name: "Orange", domain: "orange.fr" },
      { id: "free", name: "Free", domain: "free.fr" },
      {
        id: "bouygues",
        name: "Bouygues Telecom",
        domain: "bouyguestelecom.fr",
      },
      { id: "sfr", name: "SFR / RED", domain: "sfr.fr" },
    ];

    for (const merchant of defaults) {
      const existing = await this.merchants.findById(merchant.id);
      if (!existing) {
        await this.merchants.create(merchant);
      }
    }
  }

  /**
   * Fills in category/merchant on deals collected before those fields were
   * derived automatically.
   *
   * Only ever writes columns that are currently empty, and only from data
   * the deal already carries (its title, its source) — nothing is invented,
   * and a deal whose category was set deliberately is never overwritten.
   * Without this, deals already in the database stay unfilterable until
   * they happen to be re-collected.
   */
  protected async backfillDealMetadata() {
    const stale = await this.deals.findMany({
      where: {
        or: [
          { categoryId: { isNull: true } },
          { merchantId: { isNull: true } },
        ],
      },
    });

    for (const deal of stale) {
      await this.deals.updateById(deal.id, {
        categoryId: deal.categoryId ?? this.categorization.classify(deal.title),
        merchantId:
          deal.merchantId ?? DEFAULT_MERCHANT_BY_SOURCE[deal.sourceId],
      });
    }
  }
}
