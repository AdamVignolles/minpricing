/**
 * Keepa's price-history chart for an Amazon product, as the public image
 * Keepa serves for embedding (no API key; the paid API isn't needed for
 * a picture). Amazon only: Keepa tracks nothing else.
 */

/** The ASIN of an Amazon product URL ("/dp/B0C2RSJHS6", "/gp/product/…"). */
export function amazonAsin(url: string | null | undefined): string | undefined {
  if (!url || !/amazon\.[a-z.]+\//i.test(url)) return undefined;
  return url
    .match(/\/(?:dp|gp\/product|gp\/aw\/d)\/([A-Z0-9]{10})(?=[/?]|$)/i)?.[1]
    ?.toUpperCase();
}

/**
 * The last 90 days, Amazon's own price and the lowest new price, sized
 * for a Dealabs description (800×300).
 */
export function keepaChartUrl(asin: string): string {
  const params = new URLSearchParams({
    asin,
    domain: "fr",
    range: "90",
    width: "800",
    height: "300",
    amazon: "1",
    new: "1",
    salesrank: "0",
  });
  return `https://graph.keepa.com/pricehistory.png?${params}`;
}

/** The chart for a deal, when it is an Amazon product. */
export function keepaChartForDeal(deal: {
  url: string;
  sourceId?: string;
  externalId?: string;
}): string | undefined {
  const asin =
    amazonAsin(deal.url) ??
    (deal.sourceId === "amazon" && /^[A-Z0-9]{10}$/.test(deal.externalId ?? "")
      ? deal.externalId
      : undefined);
  return asin ? keepaChartUrl(asin) : undefined;
}

/**
 * The Amazon product to chart on a deal page: the deal's own ASIN, else
 * the Amazon page the cross-search matched (same EAN or model) — Amazon's
 * price history for the same product is still a useful reference.
 */
export function keepaForDealPage(deal: {
  url: string;
  sourceId?: string;
  externalId?: string;
  marketPriceUrl?: string | null;
}): { asin: string; sameProductOnAmazon: boolean } | null {
  const own =
    amazonAsin(deal.url) ??
    (deal.sourceId === "amazon" && /^[A-Z0-9]{10}$/.test(deal.externalId ?? "")
      ? deal.externalId
      : undefined);
  if (own) return { asin: own, sameProductOnAmazon: false };
  const matched = amazonAsin(deal.marketPriceUrl);
  return matched ? { asin: matched, sameProductOnAmazon: true } : null;
}
