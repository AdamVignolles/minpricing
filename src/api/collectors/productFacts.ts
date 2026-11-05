import type {
  DiscoverContext,
  RawDeal,
  StoredFacts,
  StoredSpec,
} from "./DealSource.ts";

/**
 * Shared helpers for the product-page readers that fill
 * `DealDetails.facts` (epic 27). Each shop has its own pure parser; these
 * keep their output uniform: clean labels and values, no duplicates, no
 * catalogue noise (ASIN, ranking, packaging counts…), a sensible cap.
 */

const flat = (text: string | undefined | null) =>
  text
    ?.replace(/[‎‏‪-‮]/g, "")
    .replace(/\s+/g, " ")
    .trim() || undefined;

/**
 * Lines that say nothing to a buyer, or that we keep elsewhere: IDs,
 * rankings, review summaries, packaging counts, logistics.
 */
const NOISE =
  /^(asin|ean|upc|ucp|gtin|isbn|numéro (du |de )?(modèle|référence)|référence (fabricant|du fabricant)|date de mise en ligne|date de première disponibilité|classement des meilleures ventes|moyenne des commentaires|commentaires (client|des clients)|nombre d[’']articles|nombre d[’']emballages|unité de comptage|pays d[’']origine|fabri?quant|fabricant|marque|nom (du |de )?modèle|garantie( fabricant| constructeur)?|poids du colis|dimensions du colis|code produit|code article( international)?|sku|évaluation|avis)\b/i;

/** Splits a spec table into specs and the facts we store on their own. */
export function tidySpecs(
  rows: Array<{ label?: string | null; value?: string | null }>,
  max = 12,
): {
  specs: StoredSpec[];
  brand?: string;
  model?: string;
  reference?: string;
  warranty?: string;
} {
  const specs: StoredSpec[] = [];
  const seen = new Set<string>();
  // Amazon's key-attributes block and its technical table say the same
  // thing under different labels (« Technologie de mémoire RAM : DDR5 » /
  // « Technologie de mémoire vive : DDR5 »): a value already listed is
  // not repeated (short values like « 36 » or « 2 » may legitimately recur).
  const values = new Set<string>();
  let brand: string | undefined;
  let model: string | undefined;
  let reference: string | undefined;
  let warranty: string | undefined;
  for (const row of rows) {
    const label = flat(row.label)?.replace(/\s*:$/, "");
    const value = flat(row.value);
    if (!label || !value || value.length > 120) continue;
    const key = label.toLowerCase();
    if (/^marque$/i.test(label)) brand ??= value;
    else if (/^nom (du |de )?modèle$/i.test(label)) model ??= value;
    else if (
      /^(numéro (du |de )?modèle( de l[’']article)?|référence( fabricant| du fabricant)?)$/i.test(
        label,
      )
    ) {
      reference ??= value;
    } else if (/^garantie/i.test(label)) {
      warranty ??= /garantie/i.test(value) ? value : `${label} : ${value}`;
    }
    const valueKey = value.toLowerCase();
    // Past the cap, keep reading: brand, model and warranty often come
    // late in a table.
    if (specs.length >= max) continue;
    if (NOISE.test(label) || seen.has(key)) continue;
    if (valueKey.length >= 3 && values.has(valueKey)) continue;
    seen.add(key);
    values.add(valueKey);
    // « appareils compatibles » → « Appareils compatibles ».
    specs.push({ label: label[0].toUpperCase() + label.slice(1), value });
  }
  return { specs, brand, model, reference, warranty };
}

/** Drops empty fields, so a stored fact always means « the page says so ». */
export function compactFacts(facts: StoredFacts): StoredFacts | undefined {
  const out: StoredFacts = {};
  for (const [key, value] of Object.entries(facts) as Array<
    [keyof StoredFacts, unknown]
  >) {
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value) && value.length === 0) continue;
    (out as Record<string, unknown>)[key] = value;
  }
  return Object.keys(out).length ? out : undefined;
}

export { flat as flatText };

/**
 * Reads the product facts of listing-only sources once per product: only
 * offers with no facts stored yet (`context.needsFacts`), at most `max`
 * per run, `pauseMs` apart. A page that fails is skipped (tried again next
 * run); never throws, so the listing itself is always returned.
 */
export async function readFactsOnce(
  deals: RawDeal[],
  options: {
    context?: DiscoverContext;
    max: number;
    step: string;
    read: (deal: RawDeal) => Promise<StoredFacts | undefined>;
    sleep: (ms: number) => Promise<void>;
    pauseMs?: number;
  },
): Promise<void> {
  const todo = deals
    .filter((deal) => options.context?.needsFacts?.(deal.externalId) ?? true)
    .slice(0, options.max);
  for (const [index, deal] of todo.entries()) {
    options.context?.progress?.(options.step, index + 1, todo.length);
    try {
      const facts = await options.read(deal);
      if (facts) deal.details = { ...deal.details, facts };
    } catch {
      // Unreadable this run: the deal keeps its listing data.
    }
    if (index < todo.length - 1) await options.sleep(options.pauseMs ?? 1_500);
  }
}
