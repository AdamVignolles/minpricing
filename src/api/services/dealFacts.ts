import type { Infer } from "alepha";

import type { StoredFacts } from "../collectors/DealSource.ts";
import type { dealEntity } from "../entities/Deal.ts";
import { isComputer, isKnownPcBrand, parsePcSpecs } from "./pcSpecs.ts";

/**
 * Everything we know about a deal that a Dealabs description could say,
 * as one typed object — and, for every fact, where it was read. The
 * description renderer (epic 27) may only write what is in here, so a
 * post never states something DealRadar did not read from a source.
 *
 * Built from the stored deal row at render time (pure, no I/O): the row
 * is refreshed by every collection run, so the facts are never staler
 * than the deal itself. A fact the source did not give is absent, never
 * guessed, and never "0" or "".
 */

export type DealRow = Infer<typeof dealEntity.schema>;

/** The deal fields the builder reads; everything but these is optional. */
export type DealFactsInput = Partial<DealRow> &
  Pick<DealRow, "title" | "url" | "currentPrice" | "sourceId">;

/**
 * How a fact was obtained.
 * - `merchant`: read on the shop's own page, listing or API by its collector;
 * - `title`: parsed from the merchant's own product title;
 * - `cross-search`: the same product found at another shop;
 * - `dealabs`: Dealabs' public history for the product;
 * - `price-history`: a price-history service (IsThereAnyDeal, DekuDeals…).
 */
export type FactVia =
  | "merchant"
  | "title"
  | "cross-search"
  | "dealabs"
  | "price-history";

export interface Provenance {
  via: FactVia;
  /** Deal columns the value comes from. */
  fields: Array<keyof DealRow>;
  /** When the value was last read, when the row records it. */
  asOf?: string;
}

export interface Fact<T> {
  value: T;
  from: Provenance;
}

export interface Spec {
  label: string;
  value: string;
}

export interface OtherShopPrice {
  merchant: string;
  price: number;
  url?: string;
}

export type WarningKind =
  | "marketplace-seller"
  | "ships-from-abroad"
  | "battery-not-included"
  | "keyboard-layout"
  | "refurbished"
  | "used"
  | "compatible-part"
  | "out-of-stock"
  | "store-pickup-only";

export interface DealFacts {
  /** Raw ids, for choosing a template (not facts to print). */
  sourceId: string;
  categoryId?: string;
  product: {
    title: Fact<string>;
    url: Fact<string>;
    imageUrl?: Fact<string>;
    ean?: Fact<string>;
    category?: Fact<string>;
    merchant?: Fact<string>;
    condition?: Fact<"new" | "refurbished" | "used">;
    brand?: Fact<string>;
    model?: Fact<string>;
    /** Maker's reference (« 80131-3NM-NIB »). */
    reference?: Fact<string>;
  };
  /** What the shop says about buying it: warranty, returns, stock, coupon. */
  offer?: {
    warranty?: Fact<string>;
    returns?: Fact<string>;
    delivery?: Fact<string>;
    /** The shop's own stock line (« Plus que 3 exemplaires »). */
    stockText?: Fact<string>;
    /** A coupon amount shown on the page (« 10 € », « 15 % »). */
    coupon?: Fact<string>;
    /** Sold for store pickup only (« Click & Collect »): a local offer. */
    storePickupOnly?: Fact<true>;
  };
  game?: {
    platforms?: Fact<string[]>;
    features?: Fact<string[]>;
    languages?: Fact<string[]>;
    edition?: Fact<string>;
  };
  variants?: {
    sizes?: Fact<string[]>;
    colors?: Fact<string[]>;
  };
  /** Mobile plans and boxes: commitment, price after the promo… */
  planTerms?: Fact<string[]>;
  /** The merchant's own text: bullet points and plain paragraphs. */
  text: {
    bullets?: Fact<string[]>;
    paragraphs?: Fact<string[]>;
  };
  /** « Libellé : valeur » lines, from the merchant text or the title. */
  specs?: Fact<Spec[]>;
  seller?: {
    name?: Fact<string>;
    soldByMerchant?: Fact<boolean>;
    shippedByMerchant?: Fact<boolean>;
    rating?: Fact<number>;
    salesCount?: Fact<number>;
    shipsFrom?: Fact<string>;
    offersCount?: Fact<number>;
  };
  reviews?: {
    rating?: Fact<number>;
    count?: Fact<number>;
    recentPurchases?: Fact<number>;
  };
  price: {
    current: Fact<number>;
    currency: string;
    /** "month" for plans and boxes. */
    billingPeriod?: "month";
    /** The shop's struck price, and whether it is a real former price. */
    listed?: Fact<{ price: number; kind?: "regular" | "rrp" }>;
    /** The shop's legal « prix le plus bas des 30 derniers jours ». */
    lowest30d?: Fact<number>;
    historicalLow?: Fact<{ price: number; at?: string; source?: string }>;
    /** Cheapest other offer on the same platform (marketplace). */
    bestOtherOffer?: Fact<number>;
    /** The same product at other shops, cheapest first. */
    otherShops?: Fact<OtherShopPrice[]>;
    dealabs?: Fact<{
      lowestPrice?: number;
      lowestAt?: string;
      postCount?: number;
      bestTemperature?: number;
    }>;
  };
  availability?: Fact<"in_stock" | "out_of_stock">;
  /** When the offer starts / ends, when the shop says (free games…). */
  window?: Fact<{ start?: string; end?: string }>;
  /** How to get the price: a code to type, when the shop states one. */
  couponCode?: Fact<string>;
  /** Things a buyer must know, each from a stored field. */
  warnings: Array<Fact<WarningKind>>;
  /** Detected from the title and specs; the renderer picks a template. */
  isComputer: boolean;
}

/** A spec line: « Processeur : Ryzen 5 », « - RAM : 16 Go ». */
const SPEC_LINE = /^\s*(?:[-•*·]\s*)?([^:\n]{2,40}?)\s*:\s*(.{1,200})$/;
const BULLET_LINE = /^\s*[-•*·]\s+(.+)$/;
/** « - Prix avec le code LENOVO10 » (Lenovo), « code promo : X ». */
const COUPON = /\bcode(?:\s+promo)?\s*:?\s+([A-Z0-9][A-Z0-9_-]{3,24})\b/;
/** The struck-price wording of a « Libellé : valeur » line that isn't a spec. */
const NOT_A_SPEC = /^(prix|lien|attention|note|info|offre|valable)/i;

const BATTERY_NOT_INCLUDED =
  /\b(sans (batterie|chargeur)|machine nue|batterie (et chargeur )?non incluse?|vendue? sans batterie)\b/i;
const KEYBOARD_LAYOUT = /\b(qwerty|qwertz)\b/i;
/** A third-party part sold « for » a brand (Makita batteries, ink…). */
const COMPATIBLE_PART =
  /\b(remplacement pour|rechange pour|replacement for|compatible (avec )?(les )?(batteries|batterie|cartouches?|toners?) )/i;

/** « PERFORMANCES ACCÉLÉRÉES » — a marketing heading, not a spec label. */
function isShouted(label: string): boolean {
  const letters = label.replace(/[^\p{L}]/gu, "");
  return letters.length >= 4 && letters === letters.toUpperCase();
}

/**
 * A computer: the quality gate's rule (« PC portable … » + a spec), or a
 * known PC brand/series whose title carries a CPU and RAM (« Lenovo
 * IdeaPad Slim 3 - Core i5 - 16 Go RAM »), which many shop titles are.
 */
function looksLikeComputer(title: string): boolean {
  if (isComputer(title)) return true;
  if (!isKnownPcBrand(title)) return false;
  const specs = parsePcSpecs(title);
  return Boolean(specs.cpu && specs.ramGb);
}

function merchantFact<T>(
  value: T,
  fields: Array<keyof DealRow>,
  asOf?: string | null,
): Fact<T> {
  return { value, from: { via: "merchant", fields, asOf: asOf ?? undefined } };
}

function present<T>(value: T | null | undefined): value is T {
  return value !== undefined && value !== null && value !== "";
}

/** Splits the merchant text into specs, bullets and plain paragraphs. */
export function splitMerchantText(text: string): {
  specs: Spec[];
  bullets: string[];
  paragraphs: string[];
} {
  const specs: Spec[] = [];
  const bullets: string[] = [];
  const paragraphs: string[] = [];
  const lines = text.split(/\r?\n/);
  // Stored merchant texts are cut at a length and end with « … »: that
  // last line is a half sentence (« … à pris… »), not a fact. Dropped.
  while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
  if (lines.length > 1 && lines[lines.length - 1].trim().endsWith("…")) {
    lines.pop();
  }
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const spec = line.match(SPEC_LINE);
    // A spec label is short and has no sentence punctuation; a bullet
    // that happens to contain « : » (« Style tactile : une hybride… ») is
    // a bullet, kept whole.
    // Amazon writes feature bullets as « TITRE EN CAPITALES: une phrase »:
    // those are bullets, not specs. A spec has a short, normally written
    // label and a short value (« RAM : 16 Go »).
    if (
      spec &&
      !NOT_A_SPEC.test(spec[1]) &&
      !isShouted(spec[1]) &&
      spec[1].split(/\s+/).length <= 5 &&
      spec[2].length <= 80 &&
      spec[2].split(/\s+/).length <= 10
    ) {
      specs.push({ label: spec[1].trim(), value: spec[2].trim() });
      continue;
    }
    const bullet = line.match(BULLET_LINE);
    if (bullet) {
      bullets.push(bullet[1].trim());
      continue;
    }
    paragraphs.push(line);
  }
  return { specs, bullets, paragraphs };
}

/** `Deal.extraFacts`; an unreadable value is no facts, never an error. */
export function parseStoredFacts(
  json?: string | null,
): StoredFacts | undefined {
  if (!json) return undefined;
  try {
    const value = JSON.parse(json) as StoredFacts;
    return value && typeof value === "object" ? value : undefined;
  } catch {
    return undefined;
  }
}

function parseOtherShops(json?: string | null): OtherShopPrice[] {
  if (!json) return [];
  try {
    const rows = JSON.parse(json) as Array<Partial<OtherShopPrice>>;
    return rows
      .filter(
        (row): row is OtherShopPrice =>
          typeof row?.merchant === "string" &&
          typeof row?.price === "number" &&
          row.price > 0,
      )
      .map((row) => ({
        merchant: row.merchant,
        price: row.price,
        url: row.url,
      }))
      .sort((a, b) => a.price - b.price);
  } catch {
    return [];
  }
}

/** PC specs from the title (and text) when the merchant text has none. */
function pcSpecs(title: string, text: string): Spec[] {
  const parsed = parsePcSpecs(`${title}\n${text}`);
  const specs: Spec[] = [];
  if (parsed.cpu) specs.push({ label: "Processeur", value: parsed.cpu });
  if (parsed.ramGb) specs.push({ label: "RAM", value: `${parsed.ramGb} Go` });
  if (parsed.storageGb) {
    specs.push({
      label: "Stockage",
      value:
        parsed.storageGb >= 1000
          ? `${(parsed.storageGb / 1000).toString().replace(".", ",")} To`
          : `${parsed.storageGb} Go`,
    });
  }
  return specs;
}

export function buildDealFacts(
  deal: DealFactsInput,
  options: { merchantName?: string; categoryName?: string } = {},
): DealFacts {
  const details = deal.detailsCheckedAt;
  const text = deal.description?.trim() ?? "";
  const split = text ? splitMerchantText(text) : undefined;

  const facts: DealFacts = {
    sourceId: deal.sourceId,
    categoryId: deal.categoryId ?? undefined,
    product: {
      title: {
        value: deal.title,
        from: { via: "merchant", fields: ["title"] },
      },
      url: { value: deal.url, from: { via: "merchant", fields: ["url"] } },
    },
    text: {},
    price: {
      current: merchantFact(
        deal.currentPrice,
        ["currentPrice"],
        deal.lastSeenAt,
      ),
      currency: deal.currency ?? "EUR",
      billingPeriod: deal.billingPeriod ?? undefined,
    },
    warnings: [],
    isComputer: looksLikeComputer(deal.title),
  };

  // Product
  if (present(deal.imageUrl)) {
    facts.product.imageUrl = merchantFact(deal.imageUrl, ["imageUrl"]);
  }
  if (present(deal.ean)) {
    facts.product.ean = merchantFact(deal.ean, ["ean"], details);
  }
  if (present(options.categoryName ?? deal.categoryId)) {
    facts.product.category = merchantFact(
      (options.categoryName ?? deal.categoryId) as string,
      ["categoryId"],
    );
  }
  if (present(options.merchantName ?? deal.merchantId)) {
    facts.product.merchant = merchantFact(
      (options.merchantName ?? deal.merchantId) as string,
      ["merchantId"],
    );
  }
  if (present(deal.condition)) {
    facts.product.condition = merchantFact(
      deal.condition,
      ["condition"],
      details,
    );
  }

  // Merchant text
  if (split?.bullets.length) {
    facts.text.bullets = merchantFact(split.bullets, ["description"], details);
  }
  if (split?.paragraphs.length) {
    facts.text.paragraphs = merchantFact(
      split.paragraphs,
      ["description"],
      details,
    );
  }
  if (split?.specs.length) {
    facts.specs = merchantFact(split.specs, ["description"], details);
  }
  if (facts.isComputer) {
    // Only what the merchant's own specs don't already say: a
    // « Configuration : Core i5, 8 Go, 256 Go SSD » line already covers
    // the CPU, RAM and storage read from the title.
    const merchantSpecs = facts.specs?.value ?? [];
    const labels = new Set(
      merchantSpecs.map((spec) => spec.label.toLowerCase()),
    );
    const said = merchantSpecs
      .map((spec) => spec.value.toLowerCase())
      .join(" | ");
    const fromTitle = pcSpecs(deal.title, text).filter(
      (spec) =>
        !labels.has(spec.label.toLowerCase()) &&
        !said.includes(spec.value.toLowerCase()),
    );
    if (fromTitle.length) {
      facts.specs = facts.specs
        ? { ...facts.specs, value: [...facts.specs.value, ...fromTitle] }
        : { value: fromTitle, from: { via: "title", fields: ["title"] } };
    }
  }

  // Facts the product page / store API gave (Deal.extraFacts).
  const stored = parseStoredFacts(deal.extraFacts);
  if (stored) {
    const fact = <T>(value: T): Fact<T> =>
      merchantFact(value, ["extraFacts"], details);
    if (stored.brand) facts.product.brand = fact(stored.brand);
    if (stored.model) facts.product.model = fact(stored.model);
    if (stored.reference) facts.product.reference = fact(stored.reference);
    if (stored.specs?.length) {
      // The page's spec table first; the merchant text's own « Libellé :
      // valeur » lines only add what it doesn't say.
      // « Genre » (store API) and « Genres » (Steam's text) are one line.
      const labelKey = (label: string) => label.toLowerCase().replace(/s$/, "");
      const labels = new Set(stored.specs.map((spec) => labelKey(spec.label)));
      const fromText = (facts.specs?.value ?? []).filter(
        (spec) => !labels.has(labelKey(spec.label)),
      );
      facts.specs = fromText.length
        ? {
            value: [...stored.specs, ...fromText],
            from: {
              via: "merchant",
              fields: ["extraFacts", "description"],
              asOf: details ?? undefined,
            },
          }
        : fact(stored.specs);
    }
    const offer: NonNullable<DealFacts["offer"]> = {};
    if (stored.warranty) offer.warranty = fact(stored.warranty);
    if (stored.returns) offer.returns = fact(stored.returns);
    if (stored.delivery) offer.delivery = fact(stored.delivery);
    if (stored.stock) offer.stockText = fact(stored.stock);
    if (stored.coupon) offer.coupon = fact(stored.coupon);
    if (stored.storePickupOnly) {
      offer.storePickupOnly = fact(true as const);
      facts.warnings.push(fact("store-pickup-only" as const));
    }
    if (Object.keys(offer).length) facts.offer = offer;
    const game: NonNullable<DealFacts["game"]> = {};
    if (stored.platforms?.length) game.platforms = fact(stored.platforms);
    if (stored.features?.length) game.features = fact(stored.features);
    if (stored.languages?.length) game.languages = fact(stored.languages);
    if (stored.edition) game.edition = fact(stored.edition);
    if (Object.keys(game).length) facts.game = game;
    const variants: NonNullable<DealFacts["variants"]> = {};
    if (stored.sizes?.length) variants.sizes = fact(stored.sizes);
    if (stored.colors?.length) variants.colors = fact(stored.colors);
    if (Object.keys(variants).length) facts.variants = variants;
    if (stored.planTerms?.length) facts.planTerms = fact(stored.planTerms);
  }

  // Seller
  const seller: NonNullable<DealFacts["seller"]> = {};
  if (present(deal.sellerName)) {
    seller.name = merchantFact(deal.sellerName, ["sellerName"], details);
  }
  if (present(deal.soldByMerchant)) {
    seller.soldByMerchant = merchantFact(
      deal.soldByMerchant,
      ["soldByMerchant"],
      details,
    );
  }
  if (present(deal.shippedByMerchant)) {
    seller.shippedByMerchant = merchantFact(
      deal.shippedByMerchant,
      ["shippedByMerchant"],
      details,
    );
  }
  if (present(deal.sellerRating)) {
    seller.rating = merchantFact(deal.sellerRating, ["sellerRating"], details);
  }
  if (present(deal.sellerSalesCount)) {
    seller.salesCount = merchantFact(
      deal.sellerSalesCount,
      ["sellerSalesCount"],
      details,
    );
  }
  if (present(deal.shipsFrom)) {
    seller.shipsFrom = merchantFact(deal.shipsFrom, ["shipsFrom"], details);
  }
  if (present(deal.offersCount)) {
    seller.offersCount = merchantFact(
      deal.offersCount,
      ["offersCount"],
      details,
    );
  }
  if (Object.keys(seller).length) facts.seller = seller;

  // Reviews
  const reviews: NonNullable<DealFacts["reviews"]> = {};
  if (present(deal.productRating)) {
    reviews.rating = merchantFact(
      deal.productRating,
      ["productRating"],
      details,
    );
  }
  if (present(deal.productReviewCount)) {
    reviews.count = merchantFact(
      deal.productReviewCount,
      ["productReviewCount"],
      details,
    );
  }
  if (present(deal.recentPurchases)) {
    reviews.recentPurchases = merchantFact(
      deal.recentPurchases,
      ["recentPurchases"],
      details,
    );
  }
  if (Object.keys(reviews).length) facts.reviews = reviews;

  // Price references
  if (present(deal.listPrice) && deal.listPrice > deal.currentPrice) {
    facts.price.listed = merchantFact(
      { price: deal.listPrice, kind: deal.listPriceKind ?? undefined },
      ["listPrice", "listPriceKind"],
      deal.lastSeenAt,
    );
  }
  if (present(deal.lowestRecentPrice)) {
    facts.price.lowest30d = merchantFact(
      deal.lowestRecentPrice,
      ["lowestRecentPrice"],
      details,
    );
  }
  if (present(deal.historicalLowPrice)) {
    facts.price.historicalLow = {
      value: {
        price: deal.historicalLowPrice,
        at: deal.historicalLowAt ?? undefined,
        source: deal.historicalLowSource ?? undefined,
      },
      from: {
        via: "price-history",
        fields: [
          "historicalLowPrice",
          "historicalLowAt",
          "historicalLowSource",
        ],
        asOf: deal.itadCheckedAt ?? undefined,
      },
    };
  }
  if (present(deal.bestOtherOfferPrice) && deal.bestOtherOfferPrice > 0) {
    facts.price.bestOtherOffer = merchantFact(
      deal.bestOtherOfferPrice,
      ["bestOtherOfferPrice"],
      details,
    );
  }
  const shops = parseOtherShops(deal.marketComparisons);
  const fromComparisons = shops.length > 0;
  if (
    !shops.length &&
    present(deal.marketPrice) &&
    present(deal.marketPriceSource)
  ) {
    shops.push({
      merchant: deal.marketPriceSource,
      price: deal.marketPrice,
      url: deal.marketPriceUrl ?? undefined,
    });
  }
  if (shops.length) {
    facts.price.otherShops = {
      value: shops,
      from: {
        via: "cross-search",
        fields: fromComparisons
          ? ["marketComparisons"]
          : ["marketPrice", "marketPriceSource", "marketPriceUrl"],
        asOf: deal.marketCheckedAt ?? undefined,
      },
    };
  }
  if (present(deal.dealabsLowestPrice) || (deal.dealabsDealsCount ?? 0) > 0) {
    facts.price.dealabs = {
      value: {
        lowestPrice: deal.dealabsLowestPrice ?? undefined,
        lowestAt: deal.dealabsLowestAt ?? undefined,
        postCount: deal.dealabsDealsCount ?? undefined,
        bestTemperature: deal.dealabsBestTemperature ?? undefined,
      },
      from: {
        via: "dealabs",
        fields: [
          "dealabsLowestPrice",
          "dealabsLowestAt",
          "dealabsDealsCount",
          "dealabsBestTemperature",
        ],
        asOf: deal.dealabsCheckedAt ?? undefined,
      },
    };
  }

  // Availability and window
  if (
    deal.availability === "in_stock" ||
    deal.availability === "out_of_stock"
  ) {
    facts.availability = merchantFact(
      deal.availability,
      ["availability"],
      deal.lastSeenAt,
    );
  }
  if (present(deal.startDate) || present(deal.endDate)) {
    facts.window = merchantFact(
      { start: deal.startDate ?? undefined, end: deal.endDate ?? undefined },
      ["startDate", "endDate"],
    );
  }
  const coupon = text.match(COUPON)?.[1];
  if (coupon) facts.couponCode = merchantFact(coupon, ["description"], details);

  // Warnings: each one backed by a stored field.
  const warn = (kind: WarningKind, from: Provenance) =>
    facts.warnings.push({ value: kind, from });
  if (deal.soldByMerchant === false) {
    warn("marketplace-seller", {
      via: "merchant",
      fields: ["soldByMerchant"],
      asOf: details ?? undefined,
    });
  }
  if (present(deal.shipsFrom) && deal.shipsFrom.toUpperCase() !== "FR") {
    warn("ships-from-abroad", {
      via: "merchant",
      fields: ["shipsFrom"],
      asOf: details ?? undefined,
    });
  }
  if (BATTERY_NOT_INCLUDED.test(deal.title)) {
    warn("battery-not-included", { via: "title", fields: ["title"] });
  }
  if (KEYBOARD_LAYOUT.test(deal.title)) {
    warn("keyboard-layout", { via: "title", fields: ["title"] });
  }
  if (COMPATIBLE_PART.test(deal.title)) {
    warn("compatible-part", { via: "title", fields: ["title"] });
  }
  if (deal.condition === "refurbished") {
    warn("refurbished", {
      via: "merchant",
      fields: ["condition"],
      asOf: details ?? undefined,
    });
  }
  if (deal.condition === "used") {
    warn("used", {
      via: "merchant",
      fields: ["condition"],
      asOf: details ?? undefined,
    });
  }
  if (deal.availability === "out_of_stock") {
    warn("out-of-stock", {
      via: "merchant",
      fields: ["availability"],
      asOf: deal.lastSeenAt ?? undefined,
    });
  }

  return facts;
}

/** Every distinct stored field the facts were built from (for audits). */
export function factFields(facts: DealFacts): Array<keyof DealRow> {
  const fields = new Set<keyof DealRow>();
  const visit = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    if ("from" in node && "value" in node) {
      for (const field of (node as Fact<unknown>).from.fields)
        fields.add(field);
      return;
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else visit(value);
    }
  };
  visit(facts);
  return [...fields];
}
