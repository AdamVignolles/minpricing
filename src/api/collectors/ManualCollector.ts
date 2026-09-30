import type { DealSource, RawDeal, TrackedProduct } from "./DealSource.ts";

/**
 * Collector for sources without a safe automated access (Amazon, Cdiscount):
 * it simply reflects the price you last entered manually via
 * `PATCH /api/products/:id` (see ProductsController). No network call, no
 * scraping — you stay in control of what price is recorded.
 */
export class ManualCollector implements DealSource {
  id = "manual";
  name = "Manual entry";

  async collect(products: TrackedProduct[]): Promise<RawDeal[]> {
    const deals: RawDeal[] = [];

    for (const product of products) {
      if (product.manualPrice === undefined) {
        // No price observed yet for this product: skip it silently.
        continue;
      }

      deals.push({
        externalId: product.id,
        title: product.title,
        url: product.url,
        price: product.manualPrice,
        currency: product.currency,
        availability: "unknown",
        merchantId: product.merchantId,
        categoryId: product.categoryId,
      });
    }

    return deals;
  }
}
