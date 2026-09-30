import type { DealSource, RawDeal, TrackedProduct } from "./DealSource.ts";

interface SteamAppDetailsResponse {
  [appId: string]: {
    success: boolean;
    data?: {
      name: string;
      price_overview?: {
        currency: string;
        initial: number;
        final: number;
        discount_percent: number;
      };
      is_free?: boolean;
    };
  };
}

interface SteamFeaturedCategoriesResponse {
  specials?: {
    items: Array<{
      id: number;
      name: string;
      discounted?: boolean;
      discount_percent?: number;
      original_price?: number;
      final_price?: number;
      currency?: string;
      header_image?: string;
    }>;
  };
}

/**
 * Collector for video games, using Steam's official (no auth required)
 * store API: https://store.steampowered.com/api/appdetails
 */
export class SteamCollector implements DealSource {
  id = "steam";
  name = "Steam";

  async collect(products: TrackedProduct[]): Promise<RawDeal[]> {
    const deals: RawDeal[] = [];

    for (const product of products) {
      if (!product.steamAppId) {
        continue;
      }

      try {
        const response = await fetch(
          `https://store.steampowered.com/api/appdetails?appids=${product.steamAppId}&cc=fr&filters=price_overview`,
        );

        if (!response.ok) {
          continue;
        }

        const json = (await response.json()) as SteamAppDetailsResponse;
        const entry = json[String(product.steamAppId)];
        const priceOverview = entry?.data?.price_overview;

        if (!entry?.success || !priceOverview) {
          // Free game, region-locked, or app not found: nothing to record.
          continue;
        }

        deals.push({
          externalId: String(product.steamAppId),
          title: product.title,
          url: product.url,
          price: priceOverview.final / 100,
          currency: priceOverview.currency,
          availability: "in_stock",
          merchantId: product.merchantId,
          categoryId: product.categoryId,
        });
      } catch {
        // Network error for this product: skip it, other products continue.
      }
    }

    return deals;
  }

  /**
   * Auto-discovers currently discounted games from Steam's public
   * "specials" list — no tracked product needed. Real, unauthenticated
   * endpoint used by the store's own homepage.
   */
  async discover(): Promise<RawDeal[]> {
    const response = await fetch(
      "https://store.steampowered.com/api/featuredcategories?cc=fr&l=french",
    );

    if (!response.ok) {
      throw new Error(`Steam featuredcategories returned ${response.status}`);
    }

    const json = (await response.json()) as SteamFeaturedCategoriesResponse;
    const items = json.specials?.items ?? [];

    return items
      .filter((item) => item.discounted && item.final_price !== undefined)
      .map((item) => ({
        externalId: String(item.id),
        title: item.name,
        url: `https://store.steampowered.com/app/${item.id}`,
        imageUrl: item.header_image,
        price: (item.final_price as number) / 100,
        currency: item.currency ?? "EUR",
        availability: "in_stock" as const,
      }));
  }
}
