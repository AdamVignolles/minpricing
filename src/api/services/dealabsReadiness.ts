/**
 * « Prêt pour Dealabs » (epic 29): would a Dealabs moderator accept this
 * post? Between 26/10 and 04/11 six of ~40 posts were hidden or deleted,
 * each for a reason we never checked: a marketplace seller below Dealabs'
 * criteria, a store-only offer without the store and its stock, no
 * product image, an imported listing in Swedish, a price only reachable
 * with a session, a description that was only the title.
 *
 * Pure: the publisher feeds it the deal, its facts, the draft about to be
 * sent and what the merchant-page check read (as an anonymous visitor —
 * a fresh browser context, no shop session), plus `config/moderation.json`.
 * Each rule answers `ok`, `fix` (DealRadar adds the missing item: a
 * « (Via Coupon) » in the title, a line in the description) or `block`.
 * Automatic paths (evening slots, end-of-run batch) never send a blocked
 * post; the deal page's button shows blocks as warnings the owner can
 * override.
 */
import type { DealFacts } from "./dealFacts.ts";
import type { PublishTrigger } from "./publishSteps.ts";

export type ReadinessRule =
  | "seller"
  | "local"
  | "image"
  | "language"
  | "availability"
  | "price-conditions"
  | "completeness";

export type ReadinessStatus = "ok" | "fix" | "block";

export interface ReadinessCheck {
  rule: ReadinessRule;
  status: ReadinessStatus;
  /** In French, shown in the publish steps and on the deal page. */
  reason: string;
}

export interface ReadinessFixes {
  /** Appended to the Dealabs title (« (Via Coupon) », « [Prime] »…). */
  titleSuffix?: string;
  /** Lines added at the end of the description (« À savoir : » block). */
  descriptionLines?: string[];
}

export interface Readiness {
  status: ReadinessStatus;
  checks: ReadinessCheck[];
  fixes: ReadinessFixes;
  /** Owner's button: blocks are only warnings. */
  overridable: boolean;
}

/** One seller Dealabs judged unreliable (grown from moderators' messages). */
export interface BlockedSeller {
  name: string;
  reason?: string;
  at?: string;
  by?: string;
}

/** `config/moderation.json`: thresholds within bounds, lists that only grow. */
export interface ModerationConfig {
  /** Marketplace seller: minimum rating /5 and number of sales. */
  minSellerRating: number;
  minSellerSales: number;
  /**
   * Per source (`aliexpress`, `fnac`…): Dealabs asks more reviews on some
   * marketplaces (/reglespublication: 100 on Amazon/Cdiscount/Darty, 500
   * on Fnac/eBay/Rakuten/AliExpress, 50 on Rueducommerce).
   */
  minSellerSalesBySource?: Record<string, number>;
  /** « Plus que N exemplaires » under this blocks. */
  minStock: number;
  sellerBlocklist: BlockedSeller[];
  /** Sources whose price or stock depends on a store. */
  localSources: string[];
  /** Words that make a marketplace seller an official one. */
  officialSellerWords?: string[];
}

export const DEFAULT_MODERATION_CONFIG: ModerationConfig = {
  minSellerRating: 4.2,
  minSellerSales: 300,
  minSellerSalesBySource: { aliexpress: 1500 },
  minStock: 5,
  sellerBlocklist: [],
  localSources: ["screwfix"],
  officialSellerWords: ["officiel", "official", "store officiel"],
};

/** The deal fields the checklist reads. */
export interface ReadinessDeal {
  sourceId: string;
  title: string;
  url: string;
  imageUrl?: string | null;
  categoryId?: string | null;
  soldByMerchant?: boolean | null;
  sellerName?: string | null;
  sellerRating?: number | null;
  sellerSalesCount?: number | null;
  availability?: string | null;
  currentPrice: number;
}

export interface ReadinessInput {
  deal: ReadinessDeal;
  facts?: Pick<DealFacts, "product" | "offer" | "warnings" | "couponCode">;
  draft: { title: string; description?: string | null };
  /** What the merchant-page check read, when it ran. */
  page?: { title?: string; text?: string; availability?: string };
  trigger: PublishTrigger;
  config?: Partial<ModerationConfig>;
}

const AUTOMATIC: PublishTrigger[] = ["schedule", "collection"];

/** Lower case, accents and punctuation folded, for name comparisons. */
export const normalizeName = (value: string): string =>
  value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

export const isBlockedSeller = (
  name: string | null | undefined,
  blocklist: BlockedSeller[],
): BlockedSeller | undefined => {
  if (!name) return undefined;
  const key = normalizeName(name);
  if (!key) return undefined;
  return blocklist.find((entry) => normalizeName(entry.name) === key);
};

/** A marketplace offer: the shop isn't the seller. */
export const isMarketplaceOffer = (deal: ReadinessDeal): boolean =>
  deal.soldByMerchant === false || deal.sourceId.startsWith("aliexpress");

/**
 * A third-party part sold « for » a brand (Makita batteries, ink, filters):
 * Dealabs reads these as knock-offs from no-name sellers.
 */
const KNOCK_OFF =
  /\b(?:remplacement pour|rechange pour|replacement for|compatible with|compatibles?(?:\s+avec)?(?:\s+les)?(?:\s+(?:batteries?|chargeurs?|cartouches?|toners?|filtres?|outils))?\s+(?=[A-Z0-9]))/;

export const isKnockOffPart = (title: string): boolean => KNOCK_OFF.test(title);

/** A seller named after the product's brand, or calling itself official. */
export function isOfficialSeller(
  sellerName: string | null | undefined,
  brand: string | undefined,
  title: string,
  words: string[] = DEFAULT_MODERATION_CONFIG.officialSellerWords ?? [],
): boolean {
  if (!sellerName) return false;
  const seller = normalizeName(sellerName);
  if (!seller) return false;
  if (words.some((word) => seller.includes(normalizeName(word)))) return true;
  const brandKey = normalizeName(
    brand ?? title.split(/\s+/).find((word) => /^[A-Z]/.test(word)) ?? "",
  );
  return brandKey.length >= 3 && seller.split(" ").includes(brandKey);
}

// --- Language ------------------------------------------------------------

const STOPWORDS: Record<string, string[]> = {
  français: [
    "le",
    "la",
    "les",
    "des",
    "du",
    "et",
    "pour",
    "avec",
    "sans",
    "une",
    "pièces",
    "noir",
    "blanc",
    "est",
    "sur",
    "dans",
  ],
  suédois: ["och", "för", "med", "till", "av", "är", "som", "st", "svart"],
  allemand: ["und", "für", "mit", "der", "die", "das", "schwarz", "stück"],
  espagnol: ["para", "con", "el", "negro", "unidades", "los", "del"],
  italien: ["per", "con", "il", "della", "nero", "pezzi", "di"],
  néerlandais: ["en", "voor", "met", "het", "zwart", "stuks", "van"],
  polonais: ["dla", "czarny", "sztuk", "oraz", "jest"],
};

/**
 * The language of a title or a page's first lines, when it clearly isn't
 * French: at least two words of one foreign language and none of the
 * French ones. English is left alone — product names are full of it.
 */
export function foreignLanguage(text: string): string | undefined {
  const words = normalizeLanguageWords(text);
  if (words.length < 3) return undefined;
  const count = (list: string[]) =>
    words.filter((word) => list.includes(word)).length;
  const french = count(STOPWORDS.français);
  let best: { language: string; hits: number } | undefined;
  for (const [language, list] of Object.entries(STOPWORDS)) {
    if (language === "français") continue;
    const hits = count(list);
    if (hits >= 2 && (!best || hits > best.hits)) best = { language, hits };
  }
  if (!best) return undefined;
  return best.hits > french * 2 ? best.language : undefined;
}

// One- and two-letter words (« i », « z », « e », « y », « st »…) are
// model names and units far more often than a language (« Lenovo … I7 »,
// 06/11): only words of three letters or more count.
const normalizeLanguageWords = (text: string): string[] =>
  text
    .toLowerCase()
    .split(/[^a-zà-ÿąćęłńóśźż]+/)
    .filter((word) => word.length >= 3);

// --- Stock ---------------------------------------------------------------

const LOW_STOCK =
  /(?:plus que|reste(?:nt)?(?: plus)?(?: que)?|seulement|only)\s+(\d{1,3})\s+(?:exemplaires?|articles?|pièces?|en stock|left|disponibles?)/i;
const UNAVAILABLE =
  /actuellement indisponible|rupture de stock|stock indisponible|currently unavailable|out of stock/i;

/** « Plus que 3 exemplaire(s) en stock » → 3. */
export function lowStockCount(text: string): number | undefined {
  const match = text.match(LOW_STOCK);
  return match ? Number(match[1]) : undefined;
}

// --- Price conditions ----------------------------------------------------

export interface PriceCondition {
  kind: "coupon" | "prime" | "subscription" | "cart";
  /** Title suffix, as Dealabs' moderators write it. */
  titleSuffix: string;
  line: string;
}

const CONDITIONS: Array<PriceCondition & { pattern: RegExp }> = [
  {
    kind: "coupon",
    pattern:
      /appliquer (?:le |un )?coupon|coupon de \d|économisez [\d,.]+ ?(?:€|%) avec (?:un |le )?coupon|bon de réduction (?:de |à appliquer)/i,
    titleSuffix: "(Via Coupon)",
    line: "Prix obtenu en cochant le coupon sur la page du produit.",
  },
  {
    kind: "prime",
    pattern:
      /(?:réservée?|exclusi(?:f|ve)) aux membres prime|offre (?:exclusive )?prime\b|prix prime\b/i,
    titleSuffix: "[Prime]",
    line: "Prix réservé aux membres Prime.",
  },
  {
    kind: "subscription",
    pattern:
      /prévoyez et économisez|avec abonnement|abonnez-vous et économisez/i,
    titleSuffix: "(Prévoyez et Économisez)",
    line: "Prix avec l'abonnement « Prévoyez et Économisez » (résiliable à tout moment).",
  },
  {
    kind: "cart",
    pattern:
      /(?:réduction|remise) (?:appliquée |calculée )?(?:au|dans le) panier|prix (?:final )?(?:affiché )?(?:au|dans le) panier/i,
    titleSuffix: "(Remise au panier)",
    line: "La remise s'applique dans le panier.",
  },
];

/** Conditions the page puts on its price (read anonymously). */
export function priceConditions(
  pageText: string,
  facts?: ReadinessInput["facts"],
): PriceCondition[] {
  const head = pageText.slice(0, 20_000);
  const found = CONDITIONS.filter((condition) => condition.pattern.test(head));
  if (
    (facts?.offer?.coupon || facts?.couponCode) &&
    !found.some((condition) => condition.kind === "coupon")
  ) {
    const coupon = CONDITIONS.find((condition) => condition.kind === "coupon");
    if (coupon) found.push(coupon);
  }
  return found.map(({ kind, titleSuffix, line }) => ({
    kind,
    titleSuffix,
    line:
      kind === "coupon" && facts?.couponCode
        ? `Prix obtenu avec le code ${facts.couponCode.value}.`
        : line,
  }));
}

const SAYS_CONDITION: Record<PriceCondition["kind"], RegExp> = {
  coupon: /coupon|code/i,
  prime: /prime/i,
  subscription: /prévoyez|abonnement/i,
  cart: /panier/i,
};

// --- Completeness --------------------------------------------------------

/** Characters the description says beyond the title (« not only the title »). */
export const MIN_DESCRIPTION_EXTRA = 80;

function descriptionExtra(title: string, description: string): number {
  let rest = description;
  for (const part of [title, ...title.split(/\s+[-–|]\s+/)]) {
    if (part.trim().length > 3) rest = rest.split(part.trim()).join(" ");
  }
  return rest.replace(/\s+/g, " ").trim().length;
}

// --- Checklist -----------------------------------------------------------

export function moderationConfig(
  partial?: Partial<ModerationConfig>,
): ModerationConfig {
  return {
    ...DEFAULT_MODERATION_CONFIG,
    ...Object.fromEntries(
      Object.entries(partial ?? {}).filter(([, value]) => value !== undefined),
    ),
  };
}

const euro = (value: number) => `${value.toFixed(1).replace(".", ",")}/5`;

/**
 * Runs every rule. The verdict is the worst status; on the owner's button
 * a block is overridable (a warning), on automatic paths it stops the post.
 */
export function assessReadiness(input: ReadinessInput): Readiness {
  const config = moderationConfig(input.config);
  const { deal, facts, draft } = input;
  const checks: ReadinessCheck[] = [];
  const fixes: ReadinessFixes = {};
  const pageText = input.page?.text ?? "";
  const add = (rule: ReadinessRule, status: ReadinessStatus, reason: string) =>
    checks.push({ rule, status, reason });

  // Seller.
  const blocked = isBlockedSeller(deal.sellerName, config.sellerBlocklist);
  const marketplace = isMarketplaceOffer(deal);
  const minSales =
    config.minSellerSalesBySource?.[deal.sourceId.split("-")[0]] ??
    config.minSellerSales;
  if (blocked) {
    add(
      "seller",
      "block",
      `Vendeur « ${deal.sellerName} » refusé par Dealabs${blocked.reason ? ` (${blocked.reason})` : ""}`,
    );
  } else if (isKnockOffPart(deal.title)) {
    add(
      "seller",
      "block",
      "Pièce « compatible / remplacement pour » une marque : Dealabs la refuse d'un vendeur sans marque",
    );
  } else if (marketplace) {
    const name = deal.sellerName?.trim();
    if (
      isOfficialSeller(
        name,
        facts?.product.brand?.value,
        deal.title,
        config.officialSellerWords,
      )
    ) {
      add("seller", "ok", `Vendeur tiers officiel de la marque (${name})`);
    } else if (
      deal.sellerRating == null ||
      deal.sellerSalesCount == null ||
      !name
    ) {
      add(
        "seller",
        "block",
        `Vendeur tiers${name ? ` « ${name} »` : ""} sans note ou nombre de ventes connus : sous les critères de fiabilité de Dealabs`,
      );
    } else if (
      deal.sellerRating < config.minSellerRating ||
      deal.sellerSalesCount < minSales
    ) {
      add(
        "seller",
        "block",
        `Vendeur tiers « ${name} » trop peu sûr pour Dealabs (${euro(deal.sellerRating)}, ${deal.sellerSalesCount} ventes ; il faut ${euro(config.minSellerRating)} et ${minSales} ventes)`,
      );
    } else {
      add(
        "seller",
        "ok",
        `Vendeur tiers « ${name} » : ${euro(deal.sellerRating)}, ${deal.sellerSalesCount} ventes`,
      );
    }
  } else {
    add("seller", "ok", "Vendu par la boutique elle-même");
  }

  // Local offers: a store, a city and the stock read on the page.
  const local =
    config.localSources.includes(deal.sourceId) ||
    facts?.offer?.storePickupOnly !== undefined;
  if (local) {
    add(
      "local",
      "block",
      "Offre locale (stock par magasin) : Dealabs exige le magasin, la ville et le stock restant, que DealRadar ne lit pas encore",
    );
  } else {
    add("local", "ok", "Offre en ligne");
  }

  // Image.
  if (deal.imageUrl?.trim()) {
    add("image", "ok", "Image produit disponible");
  } else {
    add("image", "block", "Pas d'image produit");
  }

  // Language: the title, and the page's own title and first lines.
  const titleLanguage = foreignLanguage(deal.title);
  const pageLanguage = input.page
    ? foreignLanguage(
        `${input.page.title ?? ""} ${pageText.slice(0, 1500)}`.trim(),
      )
    : undefined;
  if (titleLanguage || pageLanguage) {
    add(
      "language",
      "block",
      `Annonce en ${titleLanguage ?? pageLanguage} (produit importé) : Dealabs veut une page en français`,
    );
  } else {
    add("language", "ok", "Annonce en français");
  }

  // Availability: out of stock, or only a handful left.
  const stockText = `${facts?.offer?.stockText?.value ?? ""}\n${pageText.slice(0, 20_000)}`;
  const left = lowStockCount(stockText);
  // Same rule as the page check: a page whose schema.org data says in
  // stock may still mention « rupture » for another variant or seller.
  const inStock = /InStock|PreOrder/i.test(input.page?.availability ?? "");
  if (
    deal.availability === "out_of_stock" ||
    (!inStock && UNAVAILABLE.test(stockText))
  ) {
    add("availability", "block", "Produit indisponible ou en rupture");
  } else if (left !== undefined && left < config.minStock) {
    add(
      "availability",
      "block",
      `Plus que ${left} en stock (minimum ${config.minStock}) : le deal serait expiré avant validation`,
    );
  } else {
    add(
      "availability",
      "ok",
      left !== undefined ? `${left} en stock` : "Disponible",
    );
  }

  // Price conditions, as an anonymous visitor in France sees the page.
  const conditions = priceConditions(pageText, facts);
  if (conditions.length === 0) {
    add(
      "price-conditions",
      "ok",
      input.page
        ? "Prix sans condition pour un visiteur anonyme"
        : "Aucune condition connue",
    );
  } else {
    const missingTitle = conditions.filter(
      (condition) => !SAYS_CONDITION[condition.kind].test(draft.title),
    );
    const missingText = conditions.filter(
      (condition) =>
        !SAYS_CONDITION[condition.kind].test(draft.description ?? ""),
    );
    if (missingTitle.length === 0 && missingText.length === 0) {
      add(
        "price-conditions",
        "ok",
        `Condition déjà indiquée (${conditions.map((c) => c.kind).join(", ")})`,
      );
    } else {
      if (missingTitle.length) {
        fixes.titleSuffix = missingTitle.map((c) => c.titleSuffix).join(" ");
      }
      if (missingText.length) {
        fixes.descriptionLines = missingText.map((c) => c.line);
      }
      add(
        "price-conditions",
        "fix",
        `Condition ajoutée au titre et à la description : ${conditions.map((c) => c.titleSuffix).join(" ")}`,
      );
    }
  }

  // Completeness: more than the title, and a category.
  const extra = descriptionExtra(draft.title, draft.description ?? "");
  if (extra < MIN_DESCRIPTION_EXTRA) {
    add(
      "completeness",
      "block",
      `Description trop courte (${extra} caractères en plus du titre, il en faut ${MIN_DESCRIPTION_EXTRA})`,
    );
  } else {
    add(
      "completeness",
      "ok",
      deal.categoryId
        ? "Description complète, catégorie connue"
        : "Description complète (catégorie laissée à Dealabs)",
    );
  }

  const status: ReadinessStatus = checks.some((c) => c.status === "block")
    ? "block"
    : checks.some((c) => c.status === "fix")
      ? "fix"
      : "ok";
  return {
    status,
    checks,
    fixes,
    overridable: !AUTOMATIC.includes(input.trigger),
  };
}

/** One line for the publish step and the schedule's notes. */
export function readinessSummary(readiness: Readiness): string {
  const problems = readiness.checks.filter((c) => c.status !== "ok");
  if (problems.length === 0) return "Prêt pour Dealabs";
  return problems.map((c) => c.reason).join(" ; ");
}

/** The draft as it will be sent, with the checklist's fixes applied. */
export function applyReadinessFixes(
  draft: { title: string; description?: string | null },
  fixes: ReadinessFixes,
  fitTitle: (title: string, max: number) => string,
): { title: string; description?: string } {
  let title = draft.title;
  if (fixes.titleSuffix) {
    const room = 140 - fixes.titleSuffix.length - 1;
    title = `${fitTitle(title, room)} ${fixes.titleSuffix}`;
  }
  let description = draft.description ?? undefined;
  if (fixes.descriptionLines?.length) {
    description = `${(description ?? "").trimEnd()}\n\nÀ savoir :\n${fixes.descriptionLines.map((line) => `- ${line}`).join("\n")}`;
  }
  return { title, description };
}
