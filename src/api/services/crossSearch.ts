import { ACCESSORY, storageSizes } from "../collectors/aliexpressSignals.ts";
import { VARIANT_WORDS } from "./dealabsSearch.ts";
import { titleTokens } from "./MarketReferenceService.ts";

/** One offer for the same product at another merchant. */
export interface MarketComparison {
  merchant: string;
  title: string;
  price: number;
  url: string;
  /** Our title lists several storage options: theirs couldn't be pinned. */
  variantUnverified?: boolean;
}

/** Ordered words of a title; "Pro+" reads as "Pro Plus". */
function words(title: string): string[] {
  return (
    title
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/(\w)\+/g, "$1 plus")
      // "Mini PC" is the product type, not a "Mini" variant.
      .replace(/mini[\s-]?pc/g, "minipc")
      .split(/[^a-z0-9]+/)
      .filter(Boolean)
  );
}

/**
 * Variant words ("Pro", "Plus", "Ultra"…) that directly follow the model
 * name in their title: "Redmi Note 15 Pro+" → ["plus"]. Only the words
 * right after the model count — a chip name further on ("Dimensity
 * 7400-Ultra"), "Turbo Max" or "Windows 11 Pro" isn't the product's
 * variant.
 */
function variantsAfterModel(theirTitle: string, model: string): string[] {
  const theirs = words(theirTitle);
  const modelWords = words(model);
  const last = modelWords.at(-1);
  if (!last) return [];
  const at = theirs.indexOf(last, Math.max(0, theirs.indexOf(modelWords[0])));
  if (at < 0) return [];
  return theirs
    .slice(at + 1, at + 3)
    .filter((word) => VARIANT_WORDS.has(word) && !modelWords.includes(word));
}

/**
 * Is `theirTitle` (an Amazon/Cdiscount search result) the product behind
 * `ourTitle`, whose model is `model` ("POCO X7 Pro")?
 * - every word of the model is in their title;
 * - not an accessory, a refurbished unit or an "Asian version";
 * - variant words (Pro, Plus, Max, Ultra, Lite…) agree both ways;
 * - when our title states a single storage size, theirs is the same.
 */
export function matchesSameModel(
  ourTitle: string,
  model: string,
  theirTitle: string,
): { match: boolean; variantUnverified?: boolean } {
  if (ACCESSORY.test(theirTitle)) return { match: false };
  const theirs = titleTokens(theirTitle);
  for (const token of titleTokens(model)) {
    if (!theirs.has(token)) return { match: false };
  }
  // Our model name already carries its variant ("POCO X7 Pro"); theirs
  // must not add one right after it ("POCO X7 Pro+", "… Pro Max").
  if (variantsAfterModel(theirTitle, model).length > 0) {
    return { match: false };
  }
  const ourSizes = storageSizes(ourTitle);
  const theirSizes = storageSizes(theirTitle);
  if (ourSizes.length === 1 && theirSizes.length > 0) {
    return { match: theirSizes.includes(ourSizes[0]) };
  }
  return { match: true, variantUnverified: ourSizes.length > 1 };
}
