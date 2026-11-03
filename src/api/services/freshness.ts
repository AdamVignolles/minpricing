/**
 * When is a deal "new"? When it first appears, or when its price really
 * drops. Seen again at the same price (every hourly run), with a new
 * description or a refreshed seller, it is the same old deal and keeps
 * its date — otherwise "Plus récents" fills up with nothing new.
 */

/** Below either of these, a lower price is noise, not news. */
const MIN_DROP_RATIO = 0.01;
const MIN_DROP_EUROS = 0.5;

export function isRealPriceDrop(previous: number, next: number): boolean {
  return (
    previous > 0 &&
    next < previous * (1 - MIN_DROP_RATIO) &&
    previous - next >= MIN_DROP_EUROS
  );
}

export interface Freshness {
  freshAt: string;
  freshReason: "new" | "price-drop";
  droppedFrom?: number;
}

/**
 * The freshness fields to write when an existing deal is seen again:
 * reset on a real price drop, nothing otherwise (`undefined`).
 */
export function freshnessOnUpdate(
  previousPrice: number,
  newPrice: number,
  now: string,
  /** What the deal says now: a drop it announces may be undone. */
  current?: {
    freshReason?: string | null;
    droppedFrom?: number | null;
    firstSeenAt: string;
  },
): Freshness | undefined {
  if (isRealPriceDrop(previousPrice, newPrice)) {
    return {
      freshAt: now,
      freshReason: "price-drop",
      droppedFrom: previousPrice,
    };
  }
  // Back at (or above) the price it « dropped from »: no drop to show any
  // more (« Prix en baisse · était 31,99 € » at 32,40 €), and nothing new
  // either — the deal goes back to when it first appeared.
  if (
    current?.freshReason === "price-drop" &&
    current.droppedFrom &&
    !isRealPriceDrop(current.droppedFrom, newPrice)
  ) {
    return { freshAt: current.firstSeenAt, freshReason: "new" };
  }
  return undefined;
}
