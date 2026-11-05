import { load } from "cheerio";

import type { RawDeal, StoredFacts, StoredSpec } from "./DealSource.ts";
import { compactFacts, flatText, tidySpecs } from "./productFacts.ts";
import { parseEuro } from "./storeOffers.ts";

/**
 * Watch specialists (epic 24), read with plain `fetch` from their own
 * server-rendered sale pages. Their struck price is the brand's « prix
 * conseillé » (Timeshop24 labels it MSRP; Ocarat's is the catalogue
 * price, never said to be a former price), so it counts as `rrp`, half
 * weight: a watch deal reaches the visibility bar through a real drop in
 * our history or a price ≥ 10 % under Amazon/Cdiscount for the same
 * reference (`watchReference` + `matchesSameWatch`, through
 * `MarketReferenceService.refreshByModel`).
 */

const SELF_SOLD = {
  soldByMerchant: true,
  shippedByMerchant: true,
  condition: "new" as const,
};

function decodeHtml(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#0?39;/g, "'")
    .replace(/&#x20;|&#32;|&nbsp;/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Connected watches go to Téléphonie (Dealabs' High-Tech), others to Mode. */
const SMARTWATCH =
  /\b(garmin|polar|coros|suunto|withings|amazfit|fitbit|huawei watch|galaxy watch|apple watch|connect[ée]e?|smartwatch|hybride connect)/i;

export function watchCategoryHint(title: string): string {
  return SMARTWATCH.test(title) ? "watch:smart" : "watch:classic";
}

const SIZE_TOKEN = /^\d+(?:[.,]\d+)?(mm|m|cm|atm|bar|ct|g)$/i;

/**
 * The watch's reference (« NY4059-09AC », « TW2T87100 », « 241980.1 »):
 * the last word with a digit and at least 6 letters/digits, that isn't a
 * size (44mm, 5ATM). Undefined when the title has none: nothing reliable
 * to search for.
 */
export function watchReference(title: string): string | undefined {
  const tokens = title
    .split(/\s+/)
    .map((token) => token.replace(/^[(«"]+|[)»",;:]+$/g, ""));
  for (const token of tokens.reverse()) {
    if (!/\d/.test(token) || SIZE_TOKEN.test(token)) continue;
    if (token.replace(/[^a-z0-9]/gi, "").length >= 6) return token;
  }
  return undefined;
}

const compact = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, "");

/** A strap, a glass, a box: around the watch, not the watch. */
const WATCH_ACCESSORY =
  /^\s*(bracelet|strap|verre|protection|chargeur|câble|cable|boîte|boite|écrin|remontoir)|\b(compatible|de rechange|pour montre|reconditionn|occasion)/i;

/**
 * Is their result the same watch? Its title must carry our reference
 * (separators ignored: « NY4059-09AC » = « NY405909AC ») and not be an
 * accessory. A reference names one dial and strap, so no other check.
 */
export function matchesSameWatch(
  _ourTitle: string,
  reference: string,
  theirTitle: string,
): { match: boolean } {
  if (WATCH_ACCESSORY.test(theirTitle)) return { match: false };
  return { match: compact(theirTitle).includes(compact(reference)) };
}

// ----------------------------------------------------------- Timeshop24

/**
 * Timeshop24's « Vente de montres » page (Magento, 35 a page): brand,
 * model and reference in three spans; MSRP (`msrpClassic`) is the struck
 * price; cards marked out of stock are skipped. Keyed by Magento's
 * product id.
 */
export function parseTimeshop24Listing(html: string): RawDeal[] {
  return html
    .split('class="item product product-item"')
    .slice(1)
    .flatMap((card) => {
      const id = card.match(/data-product-id="(\d+)"/)?.[1];
      const link = card.match(
        /class="product-item-link" href="([^"]+)">([\s\S]*?)<\/a>/,
      );
      const price = Number(
        card.match(
          /data-price-amount="([\d.]+)" data-price-type="finalPrice"/,
        )?.[1],
      );
      if (!id || !link || !Number.isFinite(price) || price <= 0) return [];
      if (/in-stock-icon no/.test(card)) return [];
      const msrp = Number(
        card.match(
          /data-price-amount="([\d.]+)" data-price-type="msrpClassic"/,
        )?.[1],
      );
      const struck = Number.isFinite(msrp) && msrp > price ? msrp : undefined;
      const parts = [...link[2].matchAll(/<span>([^<]*)<\/span>/g)].map(
        (span) => decodeHtml(span[1]),
      );
      const title = parts.length ? parts.join(" ") : decodeHtml(link[2]);
      const image = card.match(
        /<img class="product-image-photo" src="([^"]+)"/,
      )?.[1];
      return [
        {
          externalId: id,
          title: `Montre ${title}`,
          url: link[1],
          imageUrl: image,
          price,
          listPrice: struck,
          currency: "EUR",
          availability: "in_stock" as const,
          merchantId: "timeshop24",
          categoryHint: watchCategoryHint(title),
          details: {
            ...SELF_SOLD,
            sellerName: "Timeshop24",
            ...(struck ? { listPriceKind: "rrp" as const } : {}),
          },
        },
      ];
    });
}

// --------------------------------------------------------------- Ocarat

/**
 * Ocarat's watch sale page (PrestaShop, 40 a page): brand and title in
 * the card, current price then the struck one. Keyed by PrestaShop's
 * product id. Ocarat also sells jewellery: only « Montre … » titles.
 */
export function parseOcaratListing(html: string): RawDeal[] {
  return html
    .split('<article class="ajax_block_product"')
    .slice(1)
    .flatMap((card) => {
      const id = card.match(/data-id-product="(\d+)"/)?.[1];
      const url = card.match(/class="product-name" href="([^"]+)"/)?.[1];
      const brand = card.match(/class="product-brand[^"]*">([^<]*)</)?.[1];
      const name = card.match(/class="product-title">([^<]*)</)?.[1];
      const price = parseEuro(
        card.match(/<span class="price product-price">([^<]*)</)?.[1],
      );
      const old = parseEuro(
        card.match(/<span class="old-price product-price">([^<]*)</)?.[1],
      );
      if (!id || !url || !name || !price || price <= 0) return [];
      const product = decodeHtml(name);
      if (!/^montre\b/i.test(product)) return [];
      const maker = brand ? decodeHtml(brand) : "";
      // « Montre Mecha Gents NY4059-09AC » + Citizen → « Montre Citizen Mecha… »
      const title = maker
        ? product.replace(/^montre\s+/i, `Montre ${maker} `)
        : product;
      const struck = old && old > price ? old : undefined;
      const image = card.match(
        /<img class="[^"]*primary-image" src="([^"]+)"/,
      )?.[1];
      return [
        {
          externalId: id,
          title,
          url,
          imageUrl: image,
          price,
          listPrice: struck,
          currency: "EUR",
          availability: "in_stock" as const,
          merchantId: "ocarat",
          categoryHint: watchCategoryHint(title),
          details: {
            ...SELF_SOLD,
            sellerName: "Ocarat",
            ...(struck ? { listPriceKind: "rrp" as const } : {}),
          },
        },
      ];
    });
}

// ----------------------------------------------------- product pages

/**
 * The watch facts a buyer checks, in that order, with the shop's label
 * variants: « Diamètre (en mm) : 38,00 » becomes « Diamètre : 38 mm ».
 */
const WATCH_SPECS: Array<{ label: string; match: RegExp; unit?: string }> = [
  { label: "Mouvement", match: /^mouvements?$/i },
  { label: "Calibre", match: /^calibres?( \(mouvements\))?$/i },
  {
    label: "Diamètre",
    match: /^(diamètre( \(en mm\))?|largeur de la casse)$/i,
    unit: "mm",
  },
  { label: "Épaisseur", match: /^épaisseur( \(en mm\))?$/i, unit: "mm" },
  {
    label: "Étanchéité",
    match: /^(étanchéité|résistance à l'eau)( \(en atm\))?$/i,
    unit: "ATM",
  },
  { label: "Verre", match: /^(qualité du verre|verre)$/i },
  {
    label: "Boîtier",
    match: /^(qualité de la matière|matière|matériel|matériau du boîtier)$/i,
  },
  {
    label: "Bracelet",
    match: /^(bracelet|matière du bracelet|matériau du bracelet)$/i,
  },
  { label: "Couleur du cadran", match: /^(couleur du cadran|cadran)$/i },
  { label: "Fabrication", match: /^fabrication$/i },
];

function watchSpecs(rows: Array<{ label?: string; value?: string }>): {
  specs: StoredSpec[];
  warranty?: string;
  brand?: string;
  reference?: string;
} {
  const specs: StoredSpec[] = [];
  let warranty: string | undefined;
  let warrantyType: string | undefined;
  const tidy = tidySpecs(rows, 60);
  for (const row of rows) {
    const label = flatText(row.label)?.replace(/\s*:$/, "");
    const value = flatText(row.value);
    if (!label || !value) continue;
    if (/^garantie$/i.test(label)) warranty ??= value;
    if (/^type de garantie$/i.test(label)) warrantyType ??= value;
    const spec = WATCH_SPECS.find((s) => s.match.test(label));
    if (!spec || specs.some((s) => s.label === spec.label)) continue;
    const number = value.replace(",", ".").match(/^\d+(\.\d+)?$/);
    const shown =
      spec.unit && number
        ? `${Number(number[0])
            .toLocaleString("fr-FR")
            .replace(/[\u202f\u00a0]/g, " ")} ${spec.unit}`
        : value;
    specs.push({ label: spec.label, value: shown });
  }
  specs.sort(
    (a, b) =>
      WATCH_SPECS.findIndex((s) => s.label === a.label) -
      WATCH_SPECS.findIndex((s) => s.label === b.label),
  );
  return {
    specs,
    warranty: warranty
      ? `Garantie ${warranty}${warrantyType ? ` (${warrantyType.toLowerCase()})` : ""}`
      : tidy.warranty,
    brand: tidy.brand,
    reference: tidy.reference,
  };
}

/** Ocarat product page: its « Caractéristiques » table (`tr.feature_*`). */
export function parseOcaratProduct(html: string): StoredFacts | undefined {
  const $ = load(html);
  const rows = $("tr[class^='feature_']")
    .toArray()
    .map((tr) => {
      const cells = $(tr).find("td");
      cells.find("br").replaceWith(", ");
      return { label: cells.first().text(), value: cells.last().text() };
    });
  const watch = watchSpecs(rows);
  const delivery = /livraison gratuite/i.test($("body").text())
    ? "Livraison gratuite"
    : undefined;
  return compactFacts({ ...watch, delivery });
}

/**
 * Timeshop24 product page: the short « Libellé : valeur » list next to
 * the price, then its specification table (`.ts-table` rows).
 */
export function parseTimeshop24Product(html: string): StoredFacts | undefined {
  const $ = load(html);
  const rows: Array<{ label?: string; value?: string }> = [];
  $(".product.attribute.overview li").each((_, li) => {
    const [label, ...rest] = $(li).text().split(":");
    rows.push({ label, value: rest.join(":") });
  });
  $(".ts-table").each((_, row) => {
    rows.push({
      label: $(row).find(".ts-table-cell.label").text(),
      value: $(row).find(".ts-table-cell.data").text(),
    });
  });
  const watch = watchSpecs(rows);
  const delivery = /livraison gratuite/i.test(
    $('meta[name="description"]').attr("content") ?? "",
  )
    ? "Livraison gratuite"
    : undefined;
  return compactFacts({ ...watch, delivery });
}
