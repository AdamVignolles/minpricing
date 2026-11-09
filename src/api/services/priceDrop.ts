import {
  assessSilentDrop,
  dailyPrices,
  type Observation,
} from "./amazonWatch.ts";

/**
 * Is a watched product's price a real promotion, or its usual swing?
 * (epic 33, « Mes ajouts »). Pure. References, in the owner's order —
 * the first one available decides:
 *   1. Amazon's « prix le plus bas des 30 derniers jours » (Omnibus);
 *   2. the shop's struck price when it is a real former price
 *      (`listPriceKind: "regular"`) — never a « prix conseillé » (`rrp`);
 *   3. the usual price from our own history (`assessSilentDrop`: median of
 *      the last 30 daily prices, steady before, at or under the month's low).
 * Whatever the reference, our history vetoes two false promotions: a
 * return to the usual price after a rise, and a price the product swings
 * to regularly. A drop is ≥ 15 % and ≥ 5 € under its reference, like a
 * silent drop.
 */

export type DropReference = "amazon-30d-low" | "shop-was" | "usual";

export type NoDropReason =
  | "not-enough-history"
  | "usual-swing"
  | "back-to-usual"
  | "above-30d-low"
  | "above-was"
  | "under-15pct"
  | "under-5eur"
  | "implausible"
  | "above-month-low"
  | "unstable";

export interface RealDrop {
  reference: DropReference;
  referencePrice: number;
  /** Rounded percentage under the reference. */
  percent: number;
  saving: number;
  /** Days of our own history behind the verdict. */
  days: number;
}

export type RealDropVerdict =
  | { drop: RealDrop }
  | { reason: NoDropReason; days: number; times?: number };

export interface RealDropInput {
  price: number;
  /** Amazon's own 30-day low, when the page shows one. */
  lowestRecentPrice?: number | null;
  /** The shop's struck price and what it is. */
  listPrice?: number | null;
  listPriceKind?: "regular" | "rrp" | null;
  /** Our `PriceHistory` rows for the deal. */
  observations: Observation[];
  now?: Date;
}

const MIN_DROP = 0.15;
const MIN_SAVING_EUROS = 5;
const MIN_HISTORY_DAYS = 3;
/** Within this of the usual price, the product is just at its usual price. */
const USUAL_BAND = 0.05;
/** A price level reached in this many separate past dips is a cycle. */
const SWING_DIPS = 2;
/** …or on this share of the days we watched. */
const SWING_SHARE = 0.3;
/** This many days at a price make it the usual one against a struck price. */
const USUAL_PROOF_DAYS = 7;
/** Days of history the cycle rule looks at. */
const SWING_WINDOW_DAYS = 90;

function median(values: number[]): number {
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.floor(ordered.length / 2)];
}

/**
 * Separate past dips to `price` (± 2 %) or lower, the current one left
 * out: a run of days at that level that reaches yesterday is today's.
 */
export function pastDips(daily: number[], price: number): number {
  const low = daily.map((p) => p <= price * 1.02);
  let end = low.length;
  while (end > 0 && low[end - 1]) end--;
  let dips = 0;
  for (let i = 0; i < end; i++) {
    if (low[i] && (i === 0 || !low[i - 1])) dips++;
  }
  return dips;
}

export function assessRealDrop(input: RealDropInput): RealDropVerdict {
  const now = input.now ?? new Date();
  const { price } = input;
  const history = dailyPrices(input.observations, now, SWING_WINDOW_DAYS);
  const days = history.length;

  // Our history vetoes, whatever the reference says.
  if (days >= MIN_HISTORY_DAYS) {
    const month = dailyPrices(input.observations, now, 30);
    const usual = median(month);
    // Back to its usual price after a temporary rise: the « was » price
    // is the rise. (A history flat at today's price — added during the
    // promotion — says nothing: the shop's references decide.)
    const rose = Math.max(...month) > usual * (1 + USUAL_BAND);
    if (rose && Math.abs(price - usual) <= usual * USUAL_BAND) {
      return { reason: "back-to-usual", days };
    }
    const dips = pastDips(history, price);
    const share =
      history.filter((p) => p <= price * 1.02).length / history.length;
    if (dips >= SWING_DIPS || (dips >= 1 && share >= SWING_SHARE)) {
      return { reason: "usual-swing", days, times: dips };
    }
  }

  const against = (
    reference: DropReference,
    referencePrice: number,
    above: NoDropReason,
  ): RealDropVerdict => {
    if (price >= referencePrice) return { reason: above, days };
    if (price < referencePrice / 3) return { reason: "implausible", days };
    const saving = referencePrice - price;
    if (saving < referencePrice * MIN_DROP) {
      return { reason: "under-15pct", days };
    }
    if (saving < MIN_SAVING_EUROS) return { reason: "under-5eur", days };
    return {
      drop: {
        reference,
        referencePrice,
        percent: Math.round((saving / referencePrice) * 100),
        saving: Math.round(saving * 100) / 100,
        days,
      },
    };
  };

  if (input.lowestRecentPrice && input.lowestRecentPrice > 0) {
    return against("amazon-30d-low", input.lowestRecentPrice, "above-30d-low");
  }
  if (
    input.listPrice &&
    input.listPrice > 0 &&
    input.listPriceKind === "regular"
  ) {
    // A week at this very price: it is the usual price now, whatever the
    // struck price says. (Amazon's 30-day low, above, is the price before
    // the promotion by law, so it isn't overruled this way.)
    if (days >= USUAL_PROOF_DAYS) {
      const usual = median(dailyPrices(input.observations, now, 30));
      if (Math.abs(price - usual) <= usual * USUAL_BAND) {
        return { reason: "back-to-usual", days };
      }
    }
    return against("shop-was", input.listPrice, "above-was");
  }
  if (days < MIN_HISTORY_DAYS) return { reason: "not-enough-history", days };
  const silent = assessSilentDrop(input.observations, price, now);
  if ("reason" in silent) {
    return {
      reason:
        silent.reason === "too-young" ? "not-enough-history" : silent.reason,
      days,
    };
  }
  return against("usual", silent.drop.usualPrice, "back-to-usual");
}

const euros = (value: number) => `${value.toFixed(2).replace(".", ",")} €`;

/** « −22 % sous le prix le plus bas des 30 derniers jours (99,90 €) ». */
export function describeDrop(drop: RealDrop): string {
  const against =
    drop.reference === "amazon-30d-low"
      ? "le prix le plus bas des 30 derniers jours"
      : drop.reference === "shop-was"
        ? "l'ancien prix affiché par la boutique"
        : `le prix habituel (${drop.days} jours suivis)`;
  return `−${drop.percent} % sous ${against} (${euros(drop.referencePrice)})`;
}

/** Why the price is not a real promotion, in French. */
export function describeNoDrop(
  verdict: Extract<RealDropVerdict, { reason: NoDropReason }>,
): string {
  switch (verdict.reason) {
    case "not-enough-history":
      return `historique en cours (${verdict.days} jour${verdict.days > 1 ? "s" : ""} suivi${verdict.days > 1 ? "s" : ""})`;
    case "usual-swing":
      return `fluctuation habituelle : déjà à ce prix ${verdict.times ?? 1} fois`;
    case "back-to-usual":
      return "prix habituel, pas une promotion";
    case "above-30d-low":
      return "pas sous le prix le plus bas des 30 derniers jours";
    case "above-was":
      return "pas sous l'ancien prix affiché";
    case "under-15pct":
      return "baisse de moins de 15 %";
    case "under-5eur":
      return "économie de moins de 5 €";
    case "implausible":
      return "prix incohérent (erreur de fiche probable)";
    case "above-month-low":
      return "pas au plus bas du mois";
    case "unstable":
      return "prix instable avant la baisse";
  }
}
