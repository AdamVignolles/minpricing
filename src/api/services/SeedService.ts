import { $hook, $inject } from "alepha";
import { $logger } from "alepha/logger";
import { $repository, sql } from "alepha/orm";

import { categoryEntity } from "../entities/Category.ts";
import { dealEntity } from "../entities/Deal.ts";
import { merchantEntity } from "../entities/Merchant.ts";
import { sourceEntity } from "../entities/Source.ts";
import { trackedProductEntity } from "../entities/TrackedProduct.ts";
import { CategorizationService } from "./CategorizationService.ts";
import { DEFAULT_MERCHANT_BY_SOURCE } from "./DealTypes.ts";
import { WatchedLinkService } from "./WatchedLinkService.ts";

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
  protected trackedProducts = $repository(trackedProductEntity);
  protected watchedLinks = $inject(WatchedLinkService);
  protected log = $logger();

  onReady = $hook({
    on: "ready",
    handler: async () => {
      await this.seedSources();
      await this.retireManualSources();
      await this.migrateTrackedProducts();
      await this.seedCategories();
      await this.seedMerchants();
      await this.backfillDealMetadata();
    },
  });

  protected async seedSources() {
    const defaults = [
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
      { id: "sosh", name: "Sosh (forfaits)", type: "scrape" as const },
      // Stores' own public APIs / pages, read without a browser.
      {
        id: "epic",
        name: "Epic Games Store (jeux gratuits)",
        type: "api" as const,
      },
      { id: "gog", name: "GOG (promos)", type: "api" as const },
      { id: "nintendo", name: "Nintendo eShop (promos)", type: "api" as const },
      {
        id: "playstation",
        name: "PlayStation Store (promos)",
        type: "api" as const,
      },
      { id: "xbox", name: "Xbox Store (promos)", type: "scrape" as const },
      { id: "lidl", name: "Lidl (non-alimentaire)", type: "api" as const },
      { id: "ikea", name: "IKEA (offres limitées)", type: "scrape" as const },
      {
        id: "freegames",
        name: "Jeux gratuits (Steam, GOG, Ubisoft, mobile…)",
        type: "api" as const,
      },
      {
        id: "leclerc",
        name: "E.Leclerc (bonnes affaires)",
        type: "api" as const,
      },
      {
        id: "carrefour",
        name: "Carrefour (bons plans high-tech & maison)",
        type: "scrape" as const,
      },
      {
        id: "grosbill",
        name: "Grosbill (prix barrés)",
        type: "scrape" as const,
      },
      { id: "nike", name: "Nike (promotions)", type: "api" as const },
      {
        id: "itjustgood",
        name: "ITJustGood (PC reconditionnés)",
        type: "scrape" as const,
      },
      { id: "joybuy", name: "Joybuy (ventes flash)", type: "scrape" as const },
      {
        id: "amazon-watch",
        name: "Amazon (baisses de prix non affichées)",
        type: "scrape" as const,
      },
      {
        id: "relances",
        name: "Relances (déjà chauds sur Dealabs)",
        type: "scrape" as const,
      },
      {
        id: "lenovo",
        name: "Lenovo (PC portables en promo)",
        type: "api" as const,
      },
      {
        id: "footlocker",
        name: "Foot Locker (soldes)",
        type: "scrape" as const,
      },
      {
        id: "castorama",
        name: "Castorama (offres du moment)",
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

  /**
   * Manual price entry is gone (products are added by link, see
   * `WatchedLink`): its `manual` and `manual-link` sources go too —
   * removed, or switched off when deals still point at them.
   */
  protected async retireManualSources() {
    for (const id of ["manual", "manual-link"]) {
      const source = await this.sources.findById(id);
      if (!source) continue;
      const deals = await this.deals.findMany({
        where: { sourceId: { eq: id } },
        limit: 1,
      });
      try {
        if (deals.length > 0) throw new Error("still has deals");
        await this.sources.deleteById(id);
      } catch {
        if (source.enabled) {
          await this.sources.updateById(id, { enabled: false });
        }
      }
    }
  }

  /**
   * Tracked products whose page is in a supported shop become watched
   * links (and stop being tracked); the others stay listed in the console
   * for the owner to decide. Runs once per product: a migrated product is
   * disabled.
   */
  protected async migrateTrackedProducts() {
    const products = await this.trackedProducts.findMany({
      where: { enabled: { eq: true } },
    });
    for (const product of products) {
      try {
        const added = await this.watchedLinks.add(
          product.url,
          "migration (produit suivi)",
        );
        if (added.ok) {
          await this.trackedProducts.updateById(product.id, {
            enabled: false,
          });
          this.log.info(
            `Tracked product "${product.title}" is now a watched link`,
          );
        }
      } catch (error) {
        this.log.warn(`Could not migrate tracked product ${product.id}`, {
          error,
        });
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
      { id: "sosh", name: "Sosh", domain: "sosh.fr" },
      { id: "epic", name: "Epic Games Store", domain: "store.epicgames.com" },
      { id: "gog", name: "GOG", domain: "gog.com" },
      { id: "nintendo", name: "Nintendo eShop", domain: "nintendo.com" },
      {
        id: "playstation",
        name: "PlayStation Store",
        domain: "store.playstation.com",
      },
      { id: "xbox", name: "Xbox Store", domain: "xbox.com" },
      { id: "lidl", name: "Lidl", domain: "lidl.fr" },
      { id: "ikea", name: "IKEA", domain: "ikea.com" },
      { id: "leclerc", name: "E.Leclerc", domain: "e.leclerc" },
      { id: "carrefour", name: "Carrefour", domain: "carrefour.fr" },
      { id: "grosbill", name: "Grosbill", domain: "grosbill.com" },
      { id: "nike", name: "Nike", domain: "nike.com" },
      { id: "lenovo", name: "Lenovo", domain: "lenovo.com" },
      { id: "itjustgood", name: "ITJustGood", domain: "itjustgood.com" },
      { id: "joybuy", name: "Joybuy", domain: "joybuy.fr" },
      { id: "footlocker", name: "Foot Locker", domain: "footlocker.fr" },
      { id: "castorama", name: "Castorama", domain: "castorama.fr" },
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
    // Deals from before `freshAt` existed are "new" as of when we first saw
    // them. One statement, a no-op once filled (a dev server can add the
    // column on its own, so the migration's own UPDATE may never run).
    await this.deals
      .updateMany(
        { freshAt: { isNull: true } },
        { freshAt: sql`"first_seen_at"`, freshReason: "new" },
      )
      .catch(() => undefined);
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
