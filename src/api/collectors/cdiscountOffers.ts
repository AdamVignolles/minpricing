/**
 * Pure parsers for what a Cdiscount product page shows about its sellers.
 * Kept free of any browser code so they can be unit-tested against the
 * exact text captured from real pages (see `test/cdiscount-offers.spec.ts`).
 */

/** One offer of Cdiscount's "Les offres disponibles" layer. */
export interface CdiscountOffer {
  price: number;
  sellerName?: string;
  shipper?: string;
  sellerRating?: number;
  sellerSalesCount?: number;
  condition?: "new" | "refurbished" | "used";
}

export interface CdiscountOffersLayer {
  current?: CdiscountOffer;
  others: CdiscountOffer[];
  /** "3 autres offres" → 3. Counts offers not rendered in the layer too. */
  othersCount?: number;
}

/**
 * Parses Cdiscount's split price rendering — "379 €99", "1 299 €00" —
 * where the cents sit after the euro sign. `parsePriceFr` would read
 * "379 €99" as 379 and silently drop the cents.
 */
export function parseSplitEuro(text: string): number | undefined {
  const compact = text.replace(/[\s  ]/g, "");
  const split = compact.match(/^(\d+)€(\d{2})$/);
  if (split) {
    return Number(`${split[1]}.${split[2]}`);
  }
  const plain = compact.match(/^(\d+(?:[.,]\d{1,2})?)€$/);
  return plain ? Number(plain[1].replace(",", ".")) : undefined;
}

export function parseCondition(
  text: string,
): CdiscountOffer["condition"] | undefined {
  if (/reconditionn/i.test(text)) return "refurbished";
  if (/occasion/i.test(text)) return "used";
  if (/\bneuf\b|neuve/i.test(text)) return "new";
  return undefined;
}

const RATING_LINE = /^(\d(?:[.,]\d)?)\s*\/\s*5$/;
const SALES_LINE = /^([\d\s  ]+)\s*ventes?$/i;
const OTHERS_LINE = /^(\d+)\s+autres?\s+offres?$/i;

/**
 * Parses the line-by-line text (`innerText`) of the offers layer that
 * opens behind the "N offres … à partir de X €" button. Measured shape:
 *
 * ```
 * L'offre actuellement consultée
 * 379 €99 · Ajouter au panier · Reconditionné - Excellent état
 * Expédié par : · Cdiscount · MIGANG · 4,4 / 5 · 15824 ventes
 * 31 autres offres
 * 374 €94 · … · Expédié par : · Cdiscount · TechnoPort · 4,1 / 5 · 6076 ventes · Voir l'offre
 * ```
 *
 * When Cdiscount itself sells, the seller name is omitted and no rating
 * follows: "Expédié par : · CDISCOUNT · Livraison".
 */
export function parseCdiscountOffersLayer(
  lines: string[],
): CdiscountOffersLayer {
  const offers: CdiscountOffer[] = [];
  let othersCount: number | undefined;
  let offer: CdiscountOffer | undefined;
  let awaiting: "shipper" | "seller" | undefined;

  for (const raw of lines) {
    const line = raw.replace(/[​-‍﻿]/g, "").trim();
    if (!line) {
      continue;
    }

    const others = line.match(OTHERS_LINE);
    if (others) {
      othersCount = Number(others[1]);
      awaiting = undefined;
      continue;
    }

    const price = parseSplitEuro(line);
    if (price !== undefined) {
      offer = { price };
      offers.push(offer);
      awaiting = undefined;
      continue;
    }

    if (!offer) {
      continue;
    }

    if (/^Expédié par\s*:?$/i.test(line)) {
      awaiting = "shipper";
      continue;
    }

    const rating = line.match(RATING_LINE);
    if (rating) {
      offer.sellerRating = Number(rating[1].replace(",", "."));
      awaiting = undefined;
      continue;
    }

    const sales = line.match(SALES_LINE);
    if (sales) {
      offer.sellerSalesCount = Number(sales[1].replace(/\D/g, ""));
      awaiting = undefined;
      continue;
    }

    if (awaiting === "shipper") {
      offer.shipper = line;
      awaiting = "seller";
      continue;
    }

    if (awaiting === "seller") {
      awaiting = undefined;
      // Cdiscount-sold offers skip the seller line: what follows the
      // shipper is the next section's heading, not a name.
      if (!/^(Livraison|Voir l.offre|Ajouter au panier)$/i.test(line)) {
        offer.sellerName = line;
        continue;
      }
    }

    const condition = parseCondition(line);
    if (condition && !offer.condition && line.length < 60) {
      offer.condition = condition;
    }
  }

  for (const entry of offers) {
    if (!entry.sellerName && entry.shipper) {
      entry.sellerName = entry.shipper;
    }
  }

  const [current, ...rest] = offers;
  return { current, others: rest, othersCount };
}

/** Is this seller Cdiscount itself rather than a marketplace seller? */
export function isCdiscount(name: string | undefined): boolean {
  return !!name && /^cdiscount$/i.test(name.trim());
}

/**
 * Parses the product page's own seller line: "Vendu par MIGANG et expédié
 * par Cdiscount", "Vendu et expédié par Cdiscount", "Vendu par Cdiscount".
 */
export function parseSellerLine(text: string): {
  sellerName?: string;
  shipper?: string;
} {
  const flat = text.replace(/\s+/g, " ").trim();
  const both = flat.match(/Vendu et expédié par (.+?)(?:\s+Expédié depuis|$)/i);
  if (both) {
    return { sellerName: both[1].trim(), shipper: both[1].trim() };
  }
  const split = flat.match(
    /Vendu par (.+?)(?: et expédié par (.+?))?(?:\s+Expédié depuis|$)/i,
  );
  if (!split) {
    return {};
  }
  return { sellerName: split[1].trim(), shipper: split[2]?.trim() };
}

/**
 * Parses the "4 offres neuves à partir de 59,95 €" summary next to the
 * buy box: the total number of offers, and the cheapest of them (which
 * may well be the one already displayed).
 */
export function parseOffersSummary(text: string): {
  offersCount?: number;
  fromPrice?: number;
} {
  const flat = text.replace(/\s+/g, " ");
  const count = flat.match(/(\d+)\s+offres?/i);
  const from = flat.match(/à partir de\s+([\d\s  ]+(?:[.,]\d{2})?)\s*€/i);
  return {
    offersCount: count ? Number(count[1]) : undefined,
    fromPrice: from
      ? Number(from[1].replace(/[\s  ]/g, "").replace(",", "."))
      : undefined,
  };
}

/**
 * Reads the struck "Prix de comparaison" from the price block's text —
 * "Prix de comparaison i 499,99 € 279 €99" → 499.99. That is Cdiscount's
 * own chosen comparison figure, so callers must treat it as a "prix
 * conseillé"-grade reference, not a former selling price.
 */
export function parseComparisonPrice(text: string): number | undefined {
  const match = text
    .replace(/[  ]/g, " ")
    .match(/Prix de comparaison\D*?(\d[\d ]*[,.]\d{2})\s*€/i);
  return match
    ? Number(match[1].replace(/ /g, "").replace(",", "."))
    : undefined;
}

/** Spec rows that are legal boilerplate or repeat the title, not product info. */
const SKIPPED_SPECS =
  /^(Nom du produit|Catégorie|Sous-état|Titre du jeu|Gamme de produit|Description du produit|Plus produit|Opérateur économique|Fabricant|Référence|EAN|Code)/i;

/** Cuts a long text at the last sentence end before `max` characters. */
export function trimToSentence(text: string, max = 420): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "));
  return end > max * 0.4 ? cut.slice(0, end + 1) : `${cut.trimEnd()}…`;
}

/**
 * A factual description from Cdiscount's own product page: the product
 * description (trimmed to a few sentences), its "Points forts", and the
 * meaningful rows of its technical sheet. Nothing invented, no price.
 */
export function buildCdiscountDescription(page: {
  summary?: string;
  strengths: string[];
  specs: Array<[string, string]>;
}): string | undefined {
  const parts: string[] = [];
  if (page.summary?.trim()) {
    parts.push(trimToSentence(page.summary));
  }

  // The page glues multi-line values: "1-4 (local)1-22 (online)".
  const clean = (text: string) =>
    text
      .replace(/\)(?=\d)/g, ") ")
      .replace(/\s+/g, " ")
      .trim();
  const strengths = page.strengths
    .map(clean)
    .filter(
      (line) => line && !/^(Points forts|Voir le descriptif)/i.test(line),
    );
  if (strengths.length) {
    parts.push(strengths.map((line) => `- ${line}`).join("\n"));
  }

  const alreadySaid = strengths.join(" ").toLowerCase();
  const seenLabels = new Set<string>();
  const specs = page.specs
    .map(([label, value]) => [label.trim(), clean(value)] as const)
    // One row per label: the sheet sometimes repeats "Marque".
    .filter(([label]) => {
      const key = label.toLowerCase();
      if (seenLabels.has(key)) return false;
      seenLabels.add(key);
      return true;
    })
    .filter(
      ([label, value]) =>
        label &&
        value &&
        value.length <= 80 &&
        !SKIPPED_SPECS.test(label) &&
        !alreadySaid.includes(label.toLowerCase()),
    )
    .slice(0, 8);
  if (specs.length) {
    parts.push(
      `Caractéristiques :\n${specs.map(([label, value]) => `- ${label} : ${value}`).join("\n")}`,
    );
  }

  return parts.length ? parts.join("\n\n") : undefined;
}

/**
 * A competing offer only counts as a credible "cheaper elsewhere" when
 * its seller is trustworthy: a 2,7/5 marketplace seller undercutting by
 * 40 cents is not a reason to call the deal bad.
 */
export const MIN_CREDIBLE_SELLER_RATING = 4;

export function cheapestCredibleOffer(
  offers: CdiscountOffer[],
  condition: CdiscountOffer["condition"],
): CdiscountOffer | undefined {
  return offers
    .filter(
      (offer) =>
        (isCdiscount(offer.sellerName) ||
          (offer.sellerRating ?? 0) >= MIN_CREDIBLE_SELLER_RATING) &&
        // Compare like with like: a used copy isn't a cheaper "new" one.
        (!condition || !offer.condition || offer.condition === condition),
    )
    .reduce<CdiscountOffer | undefined>(
      (best, offer) => (!best || offer.price < best.price ? offer : best),
      undefined,
    );
}
