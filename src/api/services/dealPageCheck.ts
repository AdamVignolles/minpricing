/**
 * Last look at the merchant's page before a deal goes to Dealabs: a
 * moderator clicks the link first, so a shop in maintenance, a product
 * gone or a price that moved gets the post deactivated (GOG maintenance,
 * 2026-10-21). Pure functions here; `DealPageCheckService` loads the page.
 */

/** What the browser read on the merchant page. */
export interface DealPageSnapshot {
  /** HTTP status of the main document (0 when unknown). */
  status: number;
  title: string;
  /** Visible text, trimmed to a reasonable size. */
  text: string;
  /** Euro amounts found in the page (text, meta tags, JSON-LD offers). */
  prices: number[];
  /** schema.org availability from JSON-LD/microdata, when present. */
  availability?: string;
}

export type DealPageVerdict =
  | { ok: true; matchedPrice?: number }
  | { ok: false; reason: string };

const MAINTENANCE =
  /maintenance in progress|en maintenance|site (?:est )?temporairement indisponible|temporarily unavailable|we'?ll be back soon|service unavailable/i;
const GONE =
  /page (?:introuvable|n'existe plus)|produit (?:introuvable|n'est plus disponible|n'existe plus)|n'est plus vendu|cette offre (?:a expiré|n'est plus disponible)|page not found|no longer available/i;
const OUT_OF_STOCK =
  /rupture de stock|actuellement indisponible|temporairement en rupture|victime de son succès|épuisé|out of stock|currently unavailable|sold out/i;
const OUT_OF_STOCK_SCHEMA = /OutOfStock|SoldOut|Discontinued/i;

/** Every euro amount in a text: "1 299,99 €", "€9.99", "9,99 €/mois". */
export function euroAmounts(text: string): number[] {
  const amounts: number[] = [];
  const pattern =
    /(?:€\s?(\d{1,3}(?:[\s .]\d{3})*(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?))|(?:(\d{1,3}(?:[\s .]\d{3})*(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?)\s?(?:€|EUR\b))/g;
  for (const match of text.matchAll(pattern)) {
    const raw = (match[1] ?? match[2] ?? "").replace(/[\s ]/g, "");
    // "1.299,99" → thousands dot; "9.99" → decimal dot.
    const normalized = /\d\.\d{3}(?:,|$)/.test(raw)
      ? raw.replace(/\./g, "").replace(",", ".")
      : raw.replace(",", ".");
    const value = Number(normalized);
    if (Number.isFinite(value)) amounts.push(value);
  }
  return amounts;
}

/**
 * Is the deal still there, accessible and at our price?
 *
 * - accessible: no 404/410, no 5xx, no maintenance page;
 * - present: not marked out of stock (schema.org first, then the usual
 *   French/English wording);
 * - good: our price is shown on the page (±1 %, at least 1 cent). A free
 *   deal is exempt — its page often shows the regular price.
 * When the page shows no euro amount at all, the price can't be confirmed
 * (blocked or not rendered): that fails too — better a backup than a post
 * a moderator rejects.
 */
export function assessDealPage(
  page: DealPageSnapshot,
  deal: { currentPrice: number },
): DealPageVerdict {
  if (page.status === 404 || page.status === 410) {
    return {
      ok: false,
      reason: `page introuvable chez le marchand (${page.status})`,
    };
  }
  const head = `${page.title}\n${page.text.slice(0, 3000)}`;
  if (page.status >= 500 || MAINTENANCE.test(head)) {
    return {
      ok: false,
      reason: `site marchand indisponible ou en maintenance${page.status >= 500 ? ` (${page.status})` : ""}`,
    };
  }
  if (GONE.test(head)) {
    return {
      ok: false,
      reason: "le produit n'est plus disponible chez le marchand",
    };
  }
  if (page.availability && OUT_OF_STOCK_SCHEMA.test(page.availability)) {
    return {
      ok: false,
      reason: "produit en rupture de stock (indiqué par la page)",
    };
  }
  if (
    !page.availability?.match(/InStock|PreOrder/i) &&
    OUT_OF_STOCK.test(page.text.slice(0, 20_000))
  ) {
    return { ok: false, reason: "produit en rupture de stock" };
  }

  if (deal.currentPrice <= 0) return { ok: true };
  if (page.prices.length === 0) {
    return {
      ok: false,
      reason: "prix introuvable sur la page (page bloquée ou non chargée)",
    };
  }
  const tolerance = Math.max(0.01, deal.currentPrice * 0.01);
  const match = page.prices.find(
    (price) => Math.abs(price - deal.currentPrice) <= tolerance,
  );
  if (match !== undefined) return { ok: true, matchedPrice: match };
  const closest = page.prices.reduce((best, price) =>
    Math.abs(price - deal.currentPrice) < Math.abs(best - deal.currentPrice)
      ? price
      : best,
  );
  return {
    ok: false,
    reason: `le prix a changé : ${deal.currentPrice.toFixed(2)} € attendu, la page affiche ${closest.toFixed(2)} €`,
  };
}
