/**
 * Merchants list one product several times (a colour, a bundle-free
 * variant…) under different ids: same name, same price. They are the same
 * deal for a reader, so lists and auto-publish keep only the first one.
 *
 * The key is the source, the first words of the title (where the product
 * name is; colours and lengthy specs come later) and the price to the euro.
 */
export function sameListingKey(deal: {
  sourceId: string;
  title: string;
  currentPrice: number;
}): string {
  const words = deal.title
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .slice(0, TITLE_WORDS);
  return `${deal.sourceId}|${words.join(" ")}|${Math.round(deal.currentPrice)}`;
}

const TITLE_WORDS = 6;

/** Keeps the first deal of each {@link sameListingKey}, order preserved. */
export function dropSameListings<
  T extends { sourceId: string; title: string; currentPrice: number },
>(deals: T[]): T[] {
  const seen = new Set<string>();
  return deals.filter((deal) => {
    const key = sameListingKey(deal);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
