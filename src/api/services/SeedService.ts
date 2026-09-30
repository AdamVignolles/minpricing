import { $hook } from "alepha";
import { $repository } from "alepha/orm";

import { categoryEntity } from "../entities/Category.ts";
import { merchantEntity } from "../entities/Merchant.ts";
import { sourceEntity } from "../entities/Source.ts";

/**
 * Seeds the sources this MVP ships with, plus a couple of common
 * categories/merchants, so the app is usable right after `alepha dev`
 * without any manual SQL. Idempotent: skips anything that already exists.
 */
export class SeedService {
  protected sources = $repository(sourceEntity);
  protected categories = $repository(categoryEntity);
  protected merchants = $repository(merchantEntity);

  onReady = $hook({
    on: "ready",
    handler: async () => {
      await this.seedSources();
      await this.seedCategories();
      await this.seedMerchants();
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
      { id: "electronics", name: "Électronique", slug: "electronics" },
      { id: "other", name: "Autre", slug: "other" },
    ];

    for (const category of defaults) {
      const existing = await this.categories.findById(category.id);
      if (!existing) {
        await this.categories.create(category);
      }
    }
  }

  protected async seedMerchants() {
    const defaults = [
      { id: "amazon", name: "Amazon", domain: "amazon.fr" },
      { id: "cdiscount", name: "Cdiscount", domain: "cdiscount.com" },
      { id: "steam", name: "Steam", domain: "store.steampowered.com" },
    ];

    for (const merchant of defaults) {
      const existing = await this.merchants.findById(merchant.id);
      if (!existing) {
        await this.merchants.create(merchant);
      }
    }
  }
}
