import type { PriceStats } from "./PricingService.ts";

export type SourceReliability = "api" | "manual" | "scrape";

const RELIABILITY_WEIGHT: Record<SourceReliability, number> = {
  api: 1,
  manual: 0.7,
  scrape: 0.5,
};

/**
 * A plain-language verdict on the *price* alone (is it below what this
 * product normally costs, and below what it costs elsewhere right now?),
 * derived from the very same references {@link ScoringService.evaluate}
 * scores — so the badge shown to the user can never disagree with the
 * numeric score behind it.
 *
 * - `excellent` / `good` / `average` / `overpriced`: at least one reference
 *   price was available to compare against.
 * - `unknown`: no reference at all — there is nothing yet to compare the
 *   current price to.
 */
export type DealClassification =
  | "excellent"
  | "good"
  | "average"
  | "overpriced"
  | "unknown";

/** Overall verdict on the 0-100 score (price + seller + product + data). */
export type DealVerdict = "excellent" | "good" | "fair" | "weak";

/**
 * Everything about an offer the score looks at besides its price history.
 * `Deal` satisfies it structurally, so the collection pipeline and the
 * detail endpoint both pass the stored deal straight in.
 */
export interface DealSignals {
  currentPrice: number;
  listPrice?: number;
  listPriceKind?: "regular" | "rrp";
  lowestRecentPrice?: number;
  marketPrice?: number;
  marketPriceSource?: string;
  bestOtherOfferPrice?: number;
  offersCount?: number;
  sellerName?: string;
  soldByMerchant?: boolean;
  shippedByMerchant?: boolean;
  sellerRating?: number;
  sellerSalesCount?: number;
  productRating?: number;
  productReviewCount?: number;
  recentPurchases?: number;
  condition?: "new" | "refurbished" | "used";
  /** Lowest price this product was already posted at on Dealabs. */
  dealabsLowestPrice?: number;
  dealabsLowestAt?: string;
  dealabsDealsCount?: number;
  dealabsBestTemperature?: number;
  /** All-time low from a price-history service (IsThereAnyDeal). */
  historicalLowPrice?: number;
  historicalLowAt?: string;
  historicalLowSource?: string;
}

export type CriterionStatus = "good" | "neutral" | "bad" | "unknown";

/** One named, capped contribution to the score — shown as-is in the UI. */
export interface ScoreCriterion {
  key:
    | "discount"
    | "competition"
    | "seller"
    | "product"
    | "history"
    | "confidence";
  label: string;
  points: number;
  max: number;
  status: CriterionStatus;
  detail: string;
}

export interface PriceReference {
  kind: "lowest30d" | "history" | "regular" | "rrp" | "listed";
  label: string;
  price: number;
  /** How much this kind of reference is believed, 0-1. */
  trust: number;
}

export interface PriceAlternative {
  label: string;
  price: number;
}

export interface DealEvaluation {
  score: number;
  verdict: DealVerdict;
  classification: DealClassification;
  criteria: ScoreCriterion[];
  /** The "normal price" the real discount was measured against, if any. */
  reference?: PriceReference & { discountPercentage: number };
  /** Every normal-price reference that was available, most trusted first. */
  references: PriceReference[];
  /** Cheapest competing offer known right now (other seller / merchant). */
  bestAlternative?: PriceAlternative;
  /** Things worth knowing before buying, in plain French. */
  warnings: string[];
}

/** Points per criterion. They add up to exactly 100. */
const MAX = {
  discount: 30,
  competition: 15,
  seller: 20,
  product: 15,
  history: 10,
  confidence: 10,
} as const;

/** 30 % above the lowest price ever seen zeroes the "history" points. */
const ZERO_HISTORY_GAP = 0.3;

/**
 * Trust given to each kind of "normal price" reference. The merchant's
 * legally-required 30-day low and a store's own regular price are facts;
 * our own history is a fact too, but a short one; a "prix conseillé" is
 * a number the merchant chose, often never actually charged — which is
 * exactly the inflated "-60 %" a deal hunter must see through.
 */
const REFERENCE_TRUST: Record<PriceReference["kind"], number> = {
  lowest30d: 1,
  regular: 0.9,
  history: 0.8,
  listed: 0.6,
  rrp: 0.5,
};

/** A real 40 % drop vs the normal price earns the full discount points. */
const FULL_DISCOUNT = 0.4;
/** Paying 10 % more than the cheapest alternative zeroes "competition". */
const ZERO_COMPETITION_GAP = 0.1;
/** Within 3 % of the cheapest alternative still counts as "the same price". */
const SAME_PRICE_TOLERANCE = 0.03;

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));
const round1 = (value: number) => Math.round(value * 10) / 10;

function euros(value: number): string {
  return `${value.toFixed(2).replace(".", ",")} €`;
}

function percent(ratio: number): string {
  return `${Math.round(ratio * 100)} %`;
}

/**
 * Scores how interesting a deal *really* is, out of 100, and explains why.
 *
 * Deliberately a transparent weighted formula rather than anything
 * learned: every criterion is a named, capped contribution with a
 * sentence attached, so the score on screen can always be justified line
 * by line. A signal that couldn't be read (no reviews exposed, seller
 * unknown...) scores as neutral — "we don't know" — never as zero, so a
 * deal isn't punished for what a source simply doesn't show.
 */
export class ScoringService {
  evaluate(
    signals: DealSignals,
    stats: PriceStats,
    reliability: SourceReliability,
  ): DealEvaluation {
    const price = signals.currentPrice;
    const references = this.references(signals, stats);
    const alternatives = this.alternatives(signals, stats);
    const warnings: string[] = [];

    // 1. Real price drop, vs what this product *normally* costs. The most
    // demanding trusted reference wins: if the 30-day low says 64,99 € but
    // our own history has seen 25,99 € for weeks, the honest discount is
    // the one against 25,99 €.
    const trusted = references.filter((ref) => ref.trust >= 0.8);
    const pool = trusted.length > 0 ? trusted : references;
    const reference = pool.length
      ? pool.reduce((lowest, ref) => (ref.price < lowest.price ? ref : lowest))
      : undefined;
    const realDiscount = reference
      ? (reference.price - price) / reference.price
      : undefined;

    let discount: ScoreCriterion;
    if (!reference || realDiscount === undefined) {
      discount = {
        key: "discount",
        label: "Baisse de prix réelle",
        points: 0,
        max: MAX.discount,
        status: "unknown",
        detail:
          "Aucun prix de référence fiable : impossible de vérifier qu'il s'agit d'une vraie baisse.",
      };
    } else if (realDiscount <= 0) {
      discount = {
        key: "discount",
        label: "Baisse de prix réelle",
        points: 0,
        max: MAX.discount,
        status: "bad",
        detail: `Pas de baisse réelle : le prix est ${realDiscount < 0 ? `supérieur de ${percent(-realDiscount)} à` : "égal à"} la référence (${reference.label}, ${euros(reference.price)}).`,
      };
    } else {
      const points =
        MAX.discount * clamp01(realDiscount / FULL_DISCOUNT) * reference.trust;
      discount = {
        key: "discount",
        label: "Baisse de prix réelle",
        points,
        max: MAX.discount,
        status:
          realDiscount >= 0.1 && reference.trust >= 0.8 ? "good" : "neutral",
        detail: `${percent(realDiscount)} de moins que la référence (${reference.label}, ${euros(reference.price)})${reference.trust < 0.8 ? " — référence peu fiable, comptée à moitié" : ""}.`,
      };
    }

    // A struck-through price far above every trusted reference is the
    // classic inflated "prix barré". Say so explicitly — but only when the
    // gap is big enough to change the picture (10 points), not over
    // rounding-level differences.
    if (
      signals.listPrice &&
      signals.listPrice > price &&
      trusted.length > 0 &&
      reference
    ) {
      const announced = (signals.listPrice - price) / signals.listPrice;
      const real = Math.max(0, realDiscount ?? 0);
      if (announced - real >= 0.1) {
        warnings.push(
          `Réduction affichée gonflée : -${percent(announced)} annoncés, mais seulement ${real > 0 ? `-${percent(real)}` : "0 %"} par rapport au prix habituel.`,
        );
      }
    }

    // 2. Competitive right now? vs other sellers / other merchants.
    const bestAlternative = alternatives.length
      ? alternatives.reduce((best, alt) =>
          alt.price < best.price ? alt : best,
        )
      : undefined;
    let competition: ScoreCriterion;
    if (!bestAlternative) {
      competition = {
        key: "competition",
        label: "Prix compétitif",
        points: MAX.competition * 0.4,
        max: MAX.competition,
        status: "unknown",
        detail: "Aucune autre offre comparable trouvée : non vérifié.",
      };
    } else {
      const gap = (price - bestAlternative.price) / bestAlternative.price;
      if (gap <= SAME_PRICE_TOLERANCE) {
        competition = {
          key: "competition",
          label: "Prix compétitif",
          points: MAX.competition,
          max: MAX.competition,
          status: "good",
          detail:
            gap < -SAME_PRICE_TOLERANCE
              ? `${percent(-gap)} moins cher que la meilleure alternative (${bestAlternative.label}, ${euros(bestAlternative.price)}).`
              : gap > 0.005
                ? `À peine plus cher (+${percent(gap)}) que la meilleure alternative (${bestAlternative.label}, ${euros(bestAlternative.price)}) : écart négligeable.`
                : `Au même niveau que la meilleure alternative (${bestAlternative.label}, ${euros(bestAlternative.price)}).`,
        };
      } else {
        competition = {
          key: "competition",
          label: "Prix compétitif",
          points: MAX.competition * clamp01(1 - gap / ZERO_COMPETITION_GAP),
          max: MAX.competition,
          status: "bad",
          detail: `${percent(gap)} plus cher que la meilleure alternative (${bestAlternative.label}, ${euros(bestAlternative.price)}).`,
        };
        warnings.push(
          `Moins cher ailleurs : ${euros(bestAlternative.price)} chez ${bestAlternative.label}.`,
        );
      }
    }

    // 3. Seller trust.
    const seller = this.sellerCriterion(signals, warnings);

    // 4. Product reviews: quality weighted by how many people said so.
    const product = this.productCriterion(signals, warnings);

    // 5. vs the lowest price this product was ever seen at.
    const history = this.historyCriterion(signals, warnings);

    // 6. Confidence in the data itself.
    const historyPart = 4 * clamp01(stats.historyPoints / 10);
    const newLowPart =
      stats.historyPoints >= 3 && stats.isNewHistoricalMin ? 3 : 0;
    const sourcePart = 3 * RELIABILITY_WEIGHT[reliability];
    const confidenceDetail = [
      `${stats.historyPoints} relevé${stats.historyPoints > 1 ? "s" : ""} de prix`,
      newLowPart ? "plus bas historique" : null,
      reliability === "api"
        ? "source officielle (API)"
        : reliability === "manual"
          ? "saisie manuelle"
          : "source lue sur la page du marchand",
    ]
      .filter(Boolean)
      .join(", ");
    const confidence: ScoreCriterion = {
      key: "confidence",
      label: "Confiance des données",
      points: historyPart + newLowPart + sourcePart,
      max: MAX.confidence,
      status: stats.historyPoints >= 5 ? "good" : "neutral",
      detail: `${confidenceDetail.charAt(0).toUpperCase()}${confidenceDetail.slice(1)}.`,
    };

    if (signals.condition === "refurbished" || signals.condition === "used") {
      warnings.push(
        signals.condition === "refurbished"
          ? "Produit reconditionné, pas neuf."
          : "Produit d'occasion, pas neuf.",
      );
    }

    const criteria = [
      discount,
      competition,
      seller,
      product,
      history,
      confidence,
    ].map((criterion) => ({ ...criterion, points: round1(criterion.points) }));
    const score = Math.round(
      Math.max(
        0,
        Math.min(
          100,
          criteria.reduce((sum, criterion) => sum + criterion.points, 0),
        ),
      ),
    );

    return {
      score,
      verdict:
        score >= 75
          ? "excellent"
          : score >= 60
            ? "good"
            : score >= 45
              ? "fair"
              : "weak",
      classification: this.classify(
        realDiscount,
        reference,
        bestAlternative,
        price,
        stats,
      ),
      criteria,
      reference:
        reference && realDiscount !== undefined
          ? {
              ...reference,
              discountPercentage: Math.round(realDiscount * 100),
            }
          : undefined,
      references,
      bestAlternative,
      warnings,
    };
  }

  /** Every "normal price" reference available, most trusted first. */
  protected references(
    signals: DealSignals,
    stats: PriceStats,
  ): PriceReference[] {
    const refs: PriceReference[] = [];
    if (signals.lowestRecentPrice && signals.lowestRecentPrice > 0) {
      refs.push({
        kind: "lowest30d",
        label: "prix le plus bas des 30 derniers jours",
        price: signals.lowestRecentPrice,
        trust: REFERENCE_TRUST.lowest30d,
      });
    }
    if (signals.listPrice && signals.listPrice > 0) {
      const kind: PriceReference["kind"] =
        signals.listPriceKind === "regular"
          ? "regular"
          : signals.listPriceKind === "rrp"
            ? "rrp"
            : "listed";
      refs.push({
        kind,
        label:
          kind === "regular"
            ? "prix habituel"
            : kind === "rrp"
              ? "prix conseillé"
              : "prix barré affiché",
        price: signals.listPrice,
        trust: REFERENCE_TRUST[kind],
      });
    }
    // Our own history only becomes a reference once it says something:
    // with 1-2 points the "average" is just today's price.
    if (stats.historyPoints >= 3 && stats.avgPrice > 0) {
      refs.push({
        kind: "history",
        label: `moyenne de nos ${stats.historyPoints} relevés`,
        price: stats.avgPrice,
        trust: REFERENCE_TRUST.history,
      });
    }
    return refs.sort((a, b) => b.trust - a.trust);
  }

  /** Competing offers available right now for the same product. */
  protected alternatives(
    signals: DealSignals,
    stats: PriceStats,
  ): PriceAlternative[] {
    const alts: PriceAlternative[] = [];
    if (signals.bestOtherOfferPrice && signals.bestOtherOfferPrice > 0) {
      alts.push({
        label: "un autre vendeur du même site",
        price: signals.bestOtherOfferPrice,
      });
    }
    if (signals.marketPrice && signals.marketPrice > 0) {
      alts.push({
        label: signals.marketPriceSource ?? "un autre marchand",
        price: signals.marketPrice,
      });
    }
    if (stats.referencePrice && stats.referencePrice > 0) {
      alts.push({ label: "Idealo", price: stats.referencePrice });
    }
    return alts;
  }

  /**
   * Compares with the lowest price the product was ever seen at: past
   * Dealabs deals (what the community already got it for) and, for games,
   * IsThereAnyDeal's all-time low. Matching that low is what a seasoned
   * deal hunter calls "the real deal"; being well above it means "wait".
   */
  protected historyCriterion(
    signals: DealSignals,
    warnings: string[],
  ): ScoreCriterion {
    const base = {
      key: "history" as const,
      label: "Historique des prix",
      max: MAX.history,
    };
    const lows: Array<{ price: number; at?: string; label: string }> = [];
    if (signals.dealabsLowestPrice && signals.dealabsLowestPrice > 0) {
      lows.push({
        price: signals.dealabsLowestPrice,
        at: signals.dealabsLowestAt,
        label: "meilleur prix déjà posté sur Dealabs",
      });
    }
    if (signals.historicalLowPrice && signals.historicalLowPrice > 0) {
      lows.push({
        price: signals.historicalLowPrice,
        at: signals.historicalLowAt,
        label: `plus bas historique, ${signals.historicalLowSource ?? "toutes boutiques"}`,
      });
    }

    const community =
      signals.dealabsDealsCount && signals.dealabsDealsCount > 0
        ? ` Déjà posté ${signals.dealabsDealsCount} fois sur Dealabs${signals.dealabsBestTemperature ? ` (jusqu'à ${Math.round(signals.dealabsBestTemperature)}°)` : ""}.`
        : "";

    if (lows.length === 0) {
      return {
        ...base,
        points: MAX.history * 0.4,
        status: "unknown",
        detail:
          "Aucun historique trouvé pour ce produit (jamais posté sur Dealabs).",
      };
    }

    const low = lows.reduce((a, b) => (b.price < a.price ? b : a));
    const when = low.at
      ? ` le ${new Date(low.at).toLocaleDateString("fr-FR")}`
      : "";
    const lowText = `${low.label}, ${euros(low.price)}${when}`;
    const gap = (signals.currentPrice - low.price) / low.price;

    if (gap <= SAME_PRICE_TOLERANCE) {
      return {
        ...base,
        points: MAX.history,
        status: "good",
        detail: `${gap < -SAME_PRICE_TOLERANCE ? "Bat" : "Égale"} le plus bas déjà vu (${lowText}).${community}`,
      };
    }

    if (gap >= 0.15) {
      warnings.push(
        `Déjà vu nettement moins cher : ${euros(low.price)}${when} (${low.label}).`,
      );
    }
    return {
      ...base,
      points: MAX.history * clamp01(1 - gap / ZERO_HISTORY_GAP),
      status: gap < 0.15 ? "neutral" : "bad",
      detail: `${percent(gap)} au-dessus du plus bas déjà vu (${lowText}).${community}`,
    };
  }

  protected sellerCriterion(
    signals: DealSignals,
    warnings: string[],
  ): ScoreCriterion {
    const base = {
      key: "seller" as const,
      label: "Fiabilité du vendeur",
      max: MAX.seller,
    };

    if (signals.soldByMerchant) {
      return {
        ...base,
        points: MAX.seller,
        status: "good",
        detail: `Vendu directement par ${signals.sellerName ?? "le marchand"}.`,
      };
    }

    if (signals.sellerRating !== undefined) {
      const ratingPart = clamp01((signals.sellerRating - 3.5) / 1.3);
      const sales = signals.sellerSalesCount ?? 0;
      const volumePart = clamp01(Math.log10(Math.max(sales, 1)) / 4);
      const shippedPart = signals.shippedByMerchant ? 4 : 0;
      const points = Math.min(
        MAX.seller,
        16 * ratingPart * (0.5 + 0.5 * volumePart) + shippedPart,
      );
      const name = signals.sellerName ?? "Vendeur tiers";
      const salesText = signals.sellerSalesCount
        ? `, ${signals.sellerSalesCount.toLocaleString("fr-FR")} ventes`
        : "";
      if (signals.sellerRating < 4 || sales < 100) {
        warnings.push(
          `Vendeur marketplace à vérifier : ${name} (${signals.sellerRating.toFixed(1).replace(".", ",")}/5${salesText}).`,
        );
      }
      return {
        ...base,
        points,
        status: points >= 14 ? "good" : points >= 8 ? "neutral" : "bad",
        detail: `Vendeur tiers ${name} : ${signals.sellerRating.toFixed(1).replace(".", ",")}/5${salesText}${signals.shippedByMerchant ? ", expédié par la plateforme" : ""}.`,
      };
    }

    if (signals.sellerName) {
      return {
        ...base,
        points: signals.shippedByMerchant ? 12 : 8,
        status: "neutral",
        detail: `Vendu par ${signals.sellerName}${signals.shippedByMerchant ? ", expédié par la plateforme" : ""} — note du vendeur inconnue.`,
      };
    }

    return {
      ...base,
      points: 8,
      status: "unknown",
      detail: "Vendeur non vérifié.",
    };
  }

  protected productCriterion(
    signals: DealSignals,
    warnings: string[],
  ): ScoreCriterion {
    const base = {
      key: "product" as const,
      label: "Avis produit",
      max: MAX.product,
    };
    // "No information" sits at 40 % of the points: a product nobody has
    // reviewed yet is neither good nor bad, and a handful of 5-star reviews
    // shouldn't outrank thousands of 4.5-star ones.
    const neutral = 0.4;

    if (signals.productRating === undefined || !signals.productReviewCount) {
      return {
        ...base,
        points: MAX.product * neutral,
        status: "unknown",
        detail: "Pas d'avis clients disponibles.",
      };
    }

    const quality = clamp01((signals.productRating - 3) / 1.7);
    const volume = clamp01(Math.log10(signals.productReviewCount + 1) / 3);
    const points = MAX.product * (volume * quality + (1 - volume) * neutral);
    const ratingText = signals.productRating.toFixed(1).replace(".", ",");
    const popularity = signals.recentPurchases
      ? `, plus de ${signals.recentPurchases.toLocaleString("fr-FR")} achats le mois dernier`
      : "";

    if (signals.productRating < 3.5 && signals.productReviewCount >= 10) {
      warnings.push(`Produit mal noté : ${ratingText}/5.`);
    }

    return {
      ...base,
      points,
      status:
        signals.productRating >= 4.2 && signals.productReviewCount >= 50
          ? "good"
          : signals.productRating < 3.5
            ? "bad"
            : "neutral",
      detail: `${ratingText}/5 sur ${signals.productReviewCount.toLocaleString("fr-FR")} avis${popularity}.`,
    };
  }

  protected classify(
    realDiscount: number | undefined,
    reference: PriceReference | undefined,
    bestAlternative: PriceAlternative | undefined,
    price: number,
    stats: PriceStats,
  ): DealClassification {
    if (
      bestAlternative &&
      price > bestAlternative.price * (1 + SAME_PRICE_TOLERANCE)
    ) {
      return "overpriced";
    }
    if (realDiscount === undefined || !reference) {
      if (bestAlternative) {
        return "average";
      }
      return stats.historyPoints >= 2 ? "average" : "unknown";
    }
    if (realDiscount < -SAME_PRICE_TOLERANCE) {
      return "overpriced";
    }
    if (reference.trust >= 0.8) {
      if (realDiscount >= 0.15) return "excellent";
      if (realDiscount >= 0.05) return "good";
      return "average";
    }
    // Only an untrusted "prix conseillé" to go on: it can make a deal look
    // good, never excellent.
    return realDiscount >= 0.3 ? "good" : "average";
  }
}
