import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Desirability: does the Dealabs community *want* this kind of product?
 * The heat model's base rates know the category and the discount, not the
 * brand or the product type — yet that is what people vote on (a Ryobi
 * grinder went to 169°, an unbranded robot vacuum to -32°).
 *
 * The weights live in `config/desirability.json` (log-odds added to the
 * heat model) so the local agents can tune them from the results without a
 * code change; `dealradar.mjs tune-stats` measures them from the Dealabs
 * history the app already stores. Brands listed with 0 are known brands:
 * they only avoid the "unknown brand" penalty.
 */
export interface DesirabilityWeights {
  /** Display name → log-odds (0 = known, neutral). */
  brands: Record<string, number>;
  /** "word|synonym" → log-odds; only the strongest match counts. */
  keywords: Record<string, number>;
  /** Added when no listed brand is in the title, for these categories. */
  noBrandPenalty: number;
  noBrandCategories: string[];
}

export interface DesirabilityTerm {
  value: number;
  reason?: string;
}

const EMPTY: DesirabilityWeights = {
  brands: {},
  keywords: {},
  noBrandPenalty: 0,
  noBrandCategories: [],
};

let cache:
  | { file: string; mtime: number; weights: DesirabilityWeights }
  | undefined;

/**
 * The current weights, re-read when the file changes. No file (Workers,
 * fresh clone) → no desirability terms at all.
 */
export function loadDesirability(
  file = join(process.cwd(), "config", "desirability.json"),
): DesirabilityWeights {
  try {
    const mtime = statSync(file).mtimeMs;
    if (cache?.file === file && cache.mtime === mtime) return cache.weights;
    const weights = { ...EMPTY, ...JSON.parse(readFileSync(file, "utf8")) };
    cache = { file, mtime, weights };
    return weights;
  } catch {
    return EMPTY;
  }
}

/** Lower-case, no accents, words separated by single spaces, padded. */
export function normalizeWords(text: string): string {
  const words = text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9+]+/g, " ")
    .trim();
  return ` ${words} `;
}

/** The first listed brand found in the title, by display name. */
export function findBrand(
  title: string,
  weights: DesirabilityWeights,
): string | undefined {
  const words = normalizeWords(title);
  return Object.keys(weights.brands).find((brand) =>
    words.includes(normalizeWords(brand)),
  );
}

/** Heat-model terms for this title, each with its French reason. */
export function desirabilityTerms(
  title: string,
  categoryId: string | null | undefined,
  weights: DesirabilityWeights,
): DesirabilityTerm[] {
  const terms: DesirabilityTerm[] = [];
  // A game's title names its store ("PlayStation Store", "Nintendo
  // Switch"), not a brand people vote for: no brand term for games.
  const brand =
    categoryId === "video-games" ? undefined : findBrand(title, weights);
  if (brand) {
    const value = weights.brands[brand];
    if (value) {
      terms.push({
        value,
        reason:
          value > 0
            ? `Marque appréciée sur Dealabs (${brand}).`
            : `Marque peu suivie sur Dealabs (${brand}).`,
      });
    }
  } else if (
    !brand &&
    categoryId !== "video-games" &&
    weights.noBrandPenalty &&
    categoryId &&
    weights.noBrandCategories.includes(categoryId)
  ) {
    terms.push({
      value: weights.noBrandPenalty,
      reason: "Marque inconnue : la communauté s'en méfie.",
    });
  }

  const words = normalizeWords(title);
  const keyword = Object.entries(weights.keywords)
    .filter(
      ([pattern, value]) =>
        value &&
        pattern
          .split("|")
          .some((variant) => words.includes(normalizeWords(variant))),
    )
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))[0];
  if (keyword) {
    const [pattern, value] = keyword;
    const label = pattern.split("|")[0];
    terms.push({
      value,
      reason:
        value > 0
          ? `Type de produit qui intéresse la communauté (${label}).`
          : `Type de produit peu demandé sur Dealabs (${label}).`,
    });
  }
  return terms;
}
