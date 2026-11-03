import type { PublishTrigger } from "./publishSteps.ts";
import { MIN_VISIBLE_SCORE } from "./ScoringService.ts";

/**
 * The merchant page showed another price right before a publish (epic
 * 25): the deal was read again from its shop and updated. Should the
 * publication go on at the new price? Same rules as when the deal was
 * picked — pure, so they are tested on their own.
 */

const euro = (value: number) =>
  `${value.toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;

/** « 89,00 € → 89,99 € ». */
export const priceChangeText = (from: number, to: number) =>
  `${euro(from)} → ${euro(to)}`;

/** Within 1 % (and a cent) — the page check's own tolerance. */
export const samePrice = (a: number, b: number) =>
  Math.abs(a - b) <= Math.max(0.01, Math.max(a, b) * 0.01);

export interface RecheckInput {
  trigger: PublishTrigger;
  before: number;
  after: number;
  score: number;
  hotChance?: number;
  /** Added by hand: the owner's pick, outside the score rules. */
  handPicked: boolean;
  /** Thresholds of automatic publishing (schedule rules or the run's). */
  minScore: number;
  minHotChance: number;
  /** Same product live on Dealabs at the new price or cheaper. */
  duplicate?: { price: number; temperature: number };
}

export type RecheckDecision =
  | { go: true; detail: string }
  | { go: false; reason: string };

export function decideAfterRefresh(input: RecheckInput): RecheckDecision {
  const change = priceChangeText(input.before, input.after);
  const moved = input.after > input.before ? "remonté" : "baissé";
  const stop = (why: string): RecheckDecision => ({
    go: false,
    reason: `Pas publié : prix ${moved} (${change}), deal mis à jour : ${why}`,
  });
  if (input.duplicate) {
    return stop(
      `déjà en ligne sur Dealabs à ${euro(input.duplicate.price)} (${Math.round(input.duplicate.temperature)}°)`,
    );
  }
  if (!input.handPicked) {
    if (input.score < MIN_VISIBLE_SCORE) {
      return stop(
        `plus d'argument prix (score ${Math.round(input.score)} < ${MIN_VISIBLE_SCORE})`,
      );
    }
    if (input.trigger !== "button") {
      if (input.score < input.minScore) {
        return stop(
          `score ${Math.round(input.score)} < ${input.minScore} pour une publication automatique`,
        );
      }
      if ((input.hotChance ?? 0) < input.minHotChance) {
        return stop(
          `chance de chauffer ${Math.round(input.hotChance ?? 0)} % < ${input.minHotChance} %`,
        );
      }
    }
  }
  return {
    go: true,
    detail: `Prix mis à jour : ${change} (score ${Math.round(input.score)})`,
  };
}
