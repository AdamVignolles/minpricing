import type { StoredDealabsDeal } from "./DealabsHistoryService.ts";
import {
  type DesirabilityTerm,
  type DesirabilityWeights,
  desirabilityTerms,
  loadDesirability,
} from "./desirability.ts";
import { isComputer, parsePcSpecs, pcWarnings } from "./pcSpecs.ts";
import type { DealEvaluation } from "./ScoringService.ts";

/**
 * Will this deal reach 100° on Dealabs? The score says whether a price is
 * really good; this says whether the community will care — not the same
 * thing (a -80 % on an unknown indie game stays at 11°, a -43 % on a
 * Lenovo laptop already posted hot goes to 948°).
 *
 * Built from data, kept transparent (every term has a sentence):
 * - base rates fitted on ~2 000 Dealabs deals 2-6 days old (logistic
 *   regression on category, real discount and price band: 42 % of them
 *   reached 100°; holdout AUC 0.63 — these alone are weak);
 * - product-level terms read from our own posts (46 deals, 4 hot): what
 *   this product already did on Dealabs, the price vs the lowest already
 *   posted, reposts, marketplace sellers. These separated hot from cold
 *   far better than anything else;
 * - an account offset: our posts reach 100° less often than the average
 *   Dealabs deal with the same features (new account, few followers).
 *
 * Re-fit when there's more data: `docs/` has nothing to regenerate it
 * automatically yet, the weights below are the fitted values, rounded.
 */

/** Fitted log-odds (Dealabs sample, Oct. 2026). */
const BASE = -0.17;
const CATEGORY: Record<string, number> = {
  "video-games": 0.6,
  diy: 0.39,
  travel: 0.37,
  auto: 0.1,
  telecom: 0.1,
  fashion: 0.02,
  kids: -0.06,
  tech: -0.07,
  sport: -0.09,
  culture: -0.17,
  home: -0.29,
  food: -0.47,
  "beauty-health": -0.7,
  other: 0.16,
};
/** Our categories → the Dealabs groups the model knows. */
const CATEGORY_GROUP: Record<string, string> = {
  computing: "tech",
  phones: "tech",
  audio: "tech",
  "tv-photo": "tech",
  appliances: "home",
  pets: "home",
};
const DISCOUNT: Array<[number, number]> = [
  [50, 0.26],
  [35, 0.32],
  [20, 0.21],
  [10, -0.06],
  [0, -0.69],
];
const NO_DISCOUNT = -0.17;
const PRICE: Array<[number, number]> = [
  [1000, 0.24],
  [300, 0.2],
  [100, -0.49],
  [30, -0.28],
  [10, -0.16],
  [0.01, -0.36],
];
const FREE = 0.73;

/**
 * Our account vs the average poster, same deal features: calibrated so
 * the mean prediction over our past posts matches what they really did.
 */
const ACCOUNT_OFFSET = -2.5;

/** A past deal this recent at our price makes ours a repost. */
const REPOST_DAYS = 14;

export interface HeatInput {
  title: string;
  categoryId?: string | null;
  currentPrice: number;
  /** Real discount in % (vs the trusted reference), if known. */
  realDiscount?: number;
  soldByMerchant?: boolean | null;
  sellerName?: string | null;
  productReviewCount?: number | null;
  /** What a buyer would object to in a computer's config (see pcSpecs). */
  specWarnings?: string[];
  /** `Deal.dealabsHistory`, parsed. */
  history?: StoredDealabsDeal[];
  /** Brand / product-type desirability (see `desirability.ts`). */
  extraTerms?: DesirabilityTerm[];
}

export interface HeatPrediction {
  /** Chance (0-100) of reaching 100°. */
  chance: number;
  label: "froid" | "tiède" | "prometteur" | "chaud";
  /** Plain French, most important first. */
  reasons: string[];
}

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
const euros = (v: number) => `${v.toFixed(2).replace(".", ",")} €`;

export function predictHeat(
  input: HeatInput,
  now = new Date(),
): HeatPrediction {
  const terms: Array<{ value: number; reason?: string }> = [];
  const category =
    CATEGORY_GROUP[input.categoryId ?? ""] ?? input.categoryId ?? "other";
  terms.push({ value: CATEGORY[category] ?? CATEGORY.other });

  if (input.currentPrice === 0) {
    terms.push({
      value: FREE,
      reason: "Gratuit : ce que Dealabs aime le plus.",
    });
  } else {
    const band = PRICE.find(([min]) => input.currentPrice >= min);
    terms.push({ value: band?.[1] ?? 0 });
  }
  if (input.realDiscount === undefined) {
    terms.push({ value: NO_DISCOUNT });
  } else {
    const band = DISCOUNT.find(([min]) => input.realDiscount! >= min);
    terms.push({
      value: band?.[1] ?? DISCOUNT[DISCOUNT.length - 1][1],
      reason:
        input.realDiscount < 10
          ? `Baisse réelle faible (-${Math.round(input.realDiscount)} %) : rarement chaud.`
          : undefined,
    });
  }

  // What this product already did on Dealabs.
  // Our own past posts say nothing about how others vote for the product.
  const history = (input.history ?? []).filter((d) => d.price > 0 && !d.mine);
  if (history.length > 0) {
    const best = Math.max(...history.map((d) => d.temperature));
    const lowest = Math.min(...history.map((d) => d.price));
    if (best >= 500) {
      terms.push({
        value: 1,
        reason: `Produit déjà très chaud sur Dealabs (jusqu'à ${best}°).`,
      });
    } else if (best >= 200) {
      terms.push({ value: 0.6, reason: `Déjà chaud sur Dealabs (${best}°).` });
    } else if (best >= 100) {
      terms.push({ value: 0.3, reason: `Déjà posté à ${best}°.` });
    } else if (best < 50) {
      terms.push({
        value: -0.6,
        reason: `Déjà posté sur Dealabs sans succès (${best}° au mieux).`,
      });
    }

    const ratio = input.currentPrice / lowest;
    if (input.currentPrice > 0 && ratio <= 0.97) {
      terms.push({
        value: 0.6,
        reason: `Nouveau record : moins cher que les ${euros(lowest)} déjà postés.`,
      });
    } else if (ratio > 1.1) {
      terms.push({
        value: -0.9,
        reason: `Déjà posté moins cher (${euros(lowest)}) : on dira « déjà vu moins cher ».`,
      });
    } else if (ratio > 1.03) {
      terms.push({
        value: -0.4,
        reason: `Un peu plus cher que le meilleur prix déjà posté (${euros(lowest)}).`,
      });
    }

    // Re-posting an *expired* deal is normal (back in stock, price back
    // down): only a still-live one makes ours a duplicate. Older history
    // didn't record expiry — half the penalty then.
    const repost = history.find(
      (d) =>
        d.isExpired !== true &&
        now.getTime() - new Date(d.publishedAt).getTime() <
          REPOST_DAYS * 24 * 3600 * 1000 &&
        d.price <= input.currentPrice * 1.02,
    );
    if (repost) {
      const days = Math.max(
        1,
        Math.round(
          (now.getTime() - new Date(repost.publishedAt).getTime()) /
            (24 * 3600 * 1000),
        ),
      );
      terms.push({
        value: repost.isExpired === false ? -1.5 : -0.8,
        reason: `Déjà posté il y a ${days} jour${days > 1 ? "s" : ""} à ${euros(repost.price)} : doublon probable.`,
      });
    }
  }

  terms.push(...(input.extraTerms ?? []));

  if (input.specWarnings?.length) {
    // The configuration is what PC buyers argue about first (16 Go on a
    // 1 000 € laptop went to -11°).
    terms.push({ value: -0.7, reason: input.specWarnings[0] });
  }
  if (input.soldByMerchant === false) {
    terms.push({
      value: -0.5,
      reason: `Vendeur tiers${input.sellerName ? ` (${input.sellerName})` : ""} : la communauté s'en méfie.`,
    });
  }
  if (
    history.length === 0 &&
    input.productReviewCount !== undefined &&
    input.productReviewCount !== null &&
    input.productReviewCount < 50 &&
    !["video-games", "telecom"].includes(category)
  ) {
    terms.push({
      value: -0.3,
      reason: "Produit peu connu (peu d'avis, jamais posté sur Dealabs).",
    });
  }

  const logit =
    BASE + ACCOUNT_OFFSET + terms.reduce((sum, term) => sum + term.value, 0);
  const chance = Math.round(sigmoid(logit) * 100);
  return {
    chance,
    label:
      chance >= 60
        ? "chaud"
        : chance >= 35
          ? "prometteur"
          : chance >= 15
            ? "tiède"
            : "froid",
    reasons: terms
      .filter((term) => term.reason)
      .sort((a, b) => Math.abs(b.value) - Math.abs(a.value))
      .map((term) => term.reason!),
  };
}

/** `predictHeat` from a stored deal and its score evaluation. */
export function predictDealHeat(
  deal: {
    title: string;
    categoryId?: string | null;
    currentPrice: number;
    soldByMerchant?: boolean | null;
    sellerName?: string | null;
    productReviewCount?: number | null;
    dealabsHistory?: string | null;
    description?: string | null;
  },
  evaluation: Pick<DealEvaluation, "reference">,
  now = new Date(),
  desirability: DesirabilityWeights = loadDesirability(),
): HeatPrediction {
  let history: StoredDealabsDeal[] = [];
  try {
    history = deal.dealabsHistory ? JSON.parse(deal.dealabsHistory) : [];
  } catch {
    // Unreadable history: predict without it.
  }
  const discount = evaluation.reference?.discountPercentage;
  return predictHeat(
    {
      title: deal.title,
      categoryId: deal.categoryId,
      currentPrice: deal.currentPrice,
      realDiscount: discount === undefined ? undefined : Math.max(0, discount),
      soldByMerchant: deal.soldByMerchant,
      sellerName: deal.sellerName,
      productReviewCount: deal.productReviewCount,
      history,
      extraTerms: desirabilityTerms(deal.title, deal.categoryId, desirability),
      specWarnings: isComputer(deal.title)
        ? pcWarnings(
            parsePcSpecs(`${deal.title}\n${deal.description ?? ""}`),
            deal.currentPrice,
          )
        : undefined,
    },
    now,
  );
}
