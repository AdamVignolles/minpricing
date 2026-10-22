import type { MarketComparison } from "./crossSearch.ts";

/**
 * Mobile plans have no "normal price" to measure a drop against: what
 * makes one a deal is being cheaper than every competing plan that gives
 * at least as much. This compares each plan with the other operators'
 * current plans (all stored as `telecom` deals) on data volume.
 */

export const TELECOM_SOURCES = new Set([
  "orange",
  "sosh",
  "free",
  "bouygues",
  "sfr",
]);

/** "Illimité" counts as more than any capped plan. */
const UNLIMITED_GB = 10_000;

export interface PlanLike {
  id: string;
  title: string;
  description?: string | null;
  currentPrice: number;
  url: string;
  merchantId?: string | null;
  sourceId: string;
}

/** Monthly data in Go ("130Go", "250 Go", "illimité"), if it's a mobile plan. */
export function planDataGb(
  plan: Pick<PlanLike, "title" | "description">,
): number | undefined {
  // Boxes and packs aren't compared on data.
  if (!/forfait/i.test(plan.title) || /pack|box|fibre/i.test(plan.title)) {
    return undefined;
  }
  // "Forfait Free illimité", "internet illimité" — not "appels illimités".
  const text = `${plan.title}\n${plan.description ?? ""}`;
  if (/(forfait|internet|data)\s+(\S+\s+)?illimit/i.test(text)) {
    return UNLIMITED_GB;
  }
  // The first volume in the title, else in the description ("160Go NAT").
  const volume =
    plan.title.match(/(\d+(?:[.,]\d+)?)\s?Go\b/i) ??
    (plan.description ?? "").match(/(\d+(?:[.,]\d+)?)\s?Go\b/i);
  return volume ? Number(volume[1].replace(",", ".")) : undefined;
}

/**
 * Every other plan giving at least as much data, cheapest first — the
 * comparison table — and so the cheapest one is the market price.
 */
export function comparablePlans(
  plan: PlanLike,
  others: PlanLike[],
): MarketComparison[] {
  const data = planDataGb(plan);
  if (data === undefined) return [];
  return (
    others
      // Other operators only: an operator's own 4G/5G variants aren't
      // "the competition".
      .filter((other) => other.sourceId !== plan.sourceId)
      .flatMap((other) => {
        const otherData = planDataGb(other);
        return otherData !== undefined && otherData >= data
          ? [
              {
                merchant: other.merchantId ?? "",
                title: other.title,
                price: other.currentPrice,
                url: other.url,
              },
            ]
          : [];
      })
      .sort((a, b) => a.price - b.price)
      .slice(0, 5)
  );
}
