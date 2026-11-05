import type { DealFacts, WarningKind } from "./dealFacts.ts";
import { descriptionHtml } from "./descriptionHtml.ts";
import { COUNTRIES, PHRASES } from "./descriptionPhrases.ts";
import { priceContextLines } from "./priceContext.ts";

/**
 * Renders a Dealabs description from a deal's facts (epic 27): sections in
 * the order hot posts use, each one only when it has facts, wording from
 * the phrase bank. Pure and deterministic.
 *
 * It only prints what {@link DealFacts} holds — so never DealRadar, a
 * score, a chance to heat or an opinion. Prices only in « Repères de
 * prix » (`priceContextLines`, #129): trusted, dated, fresh figures that
 * are a real argument, and only when the caller gives `now`.
 *
 * Two outputs: plain text (what the publisher types in Dealabs' editor
 * today) and HTML (bold labels, lists), for the rich editor of #131.
 */

/**
 * Stored on each generated draft (`templateVersion`) so the debrief can
 * compare posts by template. Bump it when the wording or the sections
 * change in a way worth measuring.
 */
export const DESCRIPTION_TEMPLATE = "facts-2026.11";

export type DealType = "product" | "game" | "free-game" | "plan";

export type SectionKey =
  | "intro"
  | "howTo"
  | "price"
  | "highlights"
  | "game"
  | "plan"
  | "specs"
  | "seller"
  | "notes";

export interface DescriptionSection {
  key: SectionKey;
  /** Bold label (« Caractéristiques : »); none for the intro. */
  title?: string;
  /** Plain lines: the intro's sentences, or a list's items. */
  lines: string[];
}

export interface RenderedDescription {
  type: DealType;
  sections: DescriptionSection[];
  text: string;
  html: string;
}

const GAME_SOURCES = new Set([
  "steam",
  "gog",
  "epic",
  "nintendo",
  "playstation",
  "xbox",
  "freegames",
]);

/** Size limits: Dealabs readers skim; a wall of text is skipped. */
const LIMITS = {
  bullets: 5,
  bulletChars: 220,
  paragraphs: 2,
  paragraphChars: 420,
  specs: 10,
  specsWhenLong: 6,
  totalChars: 2200,
};

export function dealType(facts: DealFacts): DealType {
  if (facts.price.billingPeriod === "month" || facts.categoryId === "telecom") {
    return "plan";
  }
  if (GAME_SOURCES.has(facts.sourceId)) {
    return facts.price.current.value === 0 ? "free-game" : "game";
  }
  return "product";
}

/** Deterministic variant: same deal, same wording. */
function pick<T>(variants: readonly T[], seed: string): T {
  let hash = 0;
  for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return variants[hash % variants.length];
}

function fill(
  template: string,
  values: Record<string, string | undefined>,
): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => values[key] ?? "");
}

function cut(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max - 1).replace(/\s+\S*$/, "")}…`;
}

const fr = (value: number, digits = 1) =>
  value
    .toLocaleString("fr-FR", { maximumFractionDigits: digits })
    .replace(/[  ]/g, " ");

function frDate(iso: string): string | undefined {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toLocaleDateString("fr-FR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: "Europe/Paris",
  });
}

function sameName(a?: string, b?: string): boolean {
  return !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();
}

function introSection(
  facts: DealFacts,
  type: DealType,
  seed: string,
): DescriptionSection | undefined {
  const merchant = facts.product.merchant?.value;
  if (!merchant) return undefined;
  if (type === "plan") {
    return {
      key: "intro",
      lines: [fill(pick(PHRASES.intro.plan, seed), { merchant })],
    };
  }
  if (type === "free-game") {
    return {
      key: "intro",
      lines: [fill(pick(PHRASES.intro.freeGame, seed), { store: merchant })],
    };
  }
  if (type === "game") {
    const platforms = facts.game?.platforms?.value;
    return {
      key: "intro",
      lines: [
        platforms?.length
          ? fill(pick(PHRASES.intro.game, seed), {
              platforms: platforms.join(", "),
              store: merchant,
            })
          : `Jeu sur ${merchant}.`,
      ],
    };
  }
  // A product's « Vendu et expédié par … » line already names the shop:
  // no intro until the price hook of #129.
  return undefined;
}

function howToSection(facts: DealFacts): DescriptionSection | undefined {
  const lines: string[] = [];
  const coupon = facts.offer?.coupon?.value;
  if (coupon) lines.push(fill(PHRASES.howTo.coupon, { coupon }));
  const code = facts.couponCode?.value;
  if (code) lines.push(fill(PHRASES.howTo.code, { code }));
  return lines.length
    ? { key: "howTo", title: PHRASES.sections.howTo, lines }
    : undefined;
}

function highlightsSection(
  facts: DealFacts,
  seed: string,
  limits: { bullets: number; paragraphs: number },
): DescriptionSection | undefined {
  const lines: string[] = [];
  for (const paragraph of facts.text.paragraphs?.value.slice(
    0,
    limits.paragraphs,
  ) ?? []) {
    lines.push(cut(paragraph, LIMITS.paragraphChars));
  }
  for (const bullet of facts.text.bullets?.value ?? []) {
    if (lines.length >= limits.bullets + limits.paragraphs) break;
    // Already said in « Pour obtenir le prix » (Lenovo's code line).
    if (facts.couponCode && bullet.includes(facts.couponCode.value)) continue;
    lines.push(cut(calmHeading(bullet), LIMITS.bulletChars));
  }
  return lines.length
    ? {
        key: "highlights",
        title: pick(PHRASES.sections.highlights, seed),
        lines,
      }
    : undefined;
}

/**
 * Amazon's « ASPECT NOIR ET TOUCHER AGRÉABLES: Notre mémoire… » bullets,
 * in sentence case: « Aspect noir et toucher agréables : Notre mémoire… ».
 */
function calmHeading(bullet: string): string {
  const match = bullet.match(/^([^:a-zà-ÿ]{4,60}?)\s*:\s*(.+)$/u);
  if (!match || !/\p{Lu}{3}/u.test(match[1])) return bullet;
  const heading = match[1].trim().toLowerCase();
  return `${heading[0].toUpperCase()}${heading.slice(1)} : ${match[2]}`;
}

function specsSection(
  facts: DealFacts,
  max: number,
): DescriptionSection | undefined {
  const specs = facts.specs?.value.slice(0, max) ?? [];
  return specs.length
    ? {
        key: "specs",
        title: PHRASES.sections.specs,
        lines: specs.map((spec) => `${spec.label} : ${spec.value}`),
      }
    : undefined;
}

function gameSection(
  facts: DealFacts,
  type: DealType,
  highlights: string[],
): DescriptionSection | undefined {
  const lines: string[] = [];
  const platforms = facts.game?.platforms?.value;
  if (platforms?.length)
    lines.push(
      fill(PHRASES.game.platforms, { platforms: platforms.join(", ") }),
    );
  const languages = facts.game?.languages?.value;
  if (languages?.length) {
    // « Langue : textes en français, voix en français ».
    const said = languages.map((item) => item[0].toLowerCase() + item.slice(1));
    lines.push(fill(PHRASES.game.languages, { languages: said.join(", ") }));
  }
  const features = facts.game?.features?.value;
  if (features?.length)
    lines.push(
      fill(PHRASES.game.features, {
        features: features.slice(0, 5).join(", "),
      }),
    );
  const end = facts.window?.value.end;
  const date = type === "free-game" && end ? frDate(end) : undefined;
  if (date && !highlights.some((line) => /jusqu'au/i.test(line))) {
    lines.push(fill(PHRASES.game.freeUntil, { date }));
  }
  return lines.length
    ? { key: "game", title: PHRASES.sections.game, lines }
    : undefined;
}

function planSection(facts: DealFacts): DescriptionSection | undefined {
  const terms = facts.planTerms?.value ?? [];
  return terms.length
    ? { key: "plan", title: PHRASES.sections.plan, lines: terms }
    : undefined;
}

function sellerSection(
  facts: DealFacts,
  type: DealType,
): {
  section?: DescriptionSection;
  saidThirdParty: boolean;
} {
  const lines: string[] = [];
  const merchant = facts.product.merchant?.value;
  const seller = facts.seller?.name?.value;
  const sold = facts.seller?.soldByMerchant?.value;
  const shipped = facts.seller?.shippedByMerchant?.value;
  let saidThirdParty = false;
  if (seller && sold === false) {
    const rating = facts.seller?.rating?.value;
    const sales = facts.seller?.salesCount?.value;
    const sellerStats =
      rating !== undefined && sales !== undefined
        ? fill(PHRASES.seller.sellerStats, {
            rating: fr(rating),
            sales: fr(sales, 0),
          })
        : "";
    lines.push(
      shipped && merchant
        ? fill(PHRASES.seller.thirdPartyShippedBy, {
            seller,
            sellerStats,
            shipper: merchant,
          })
        : fill(PHRASES.seller.thirdParty, { seller, sellerStats }),
    );
    saidThirdParty = true;
  } else if (
    seller &&
    (sold === true || sameName(seller, merchant)) &&
    // A store sells its own games: the intro already says « sur Steam ».
    type !== "game" &&
    type !== "free-game"
  ) {
    lines.push(
      shipped === false && merchant && !sameName(seller, merchant)
        ? fill(PHRASES.seller.soldShippedBy, { seller, shipper: merchant })
        : fill(PHRASES.seller.self, { seller }),
    );
  }
  const reviews = facts.reviews;
  // Steam's review label is in the game's specs already.
  if (
    type === "product" &&
    reviews?.rating?.value !== undefined &&
    (reviews.count?.value ?? 0) >= 20
  ) {
    lines.push(
      fill(PHRASES.seller.reviews, {
        rating: fr(reviews.rating.value),
        count: fr(reviews.count!.value, 0),
      }),
    );
  }
  if (facts.offer?.delivery) lines.push(PHRASES.seller.freeDelivery);
  if (facts.offer?.returns) lines.push(facts.offer.returns.value);
  if (facts.offer?.warranty) lines.push(facts.offer.warranty.value);
  if (facts.offer?.stockText && facts.offer.stockText.value !== "En stock") {
    lines.push(facts.offer.stockText.value);
  }
  return {
    section: lines.length
      ? { key: "seller", title: PHRASES.sections.seller, lines }
      : undefined,
    saidThirdParty,
  };
}

function notesSection(
  facts: DealFacts,
  saidThirdParty: boolean,
): DescriptionSection | undefined {
  const lines: string[] = [];
  const merchant = facts.product.merchant?.value ?? "le marchand";
  const layout = facts.product.title.value
    .match(/\b(qwerty|qwertz)\b/i)?.[1]
    .toUpperCase();
  const country = facts.seller?.shipsFrom?.value;
  const seen = new Set<WarningKind>();
  for (const warning of facts.warnings) {
    const kind = warning.value;
    if (seen.has(kind)) continue;
    seen.add(kind);
    if (kind === "marketplace-seller" && saidThirdParty) continue;
    if (kind === "keyboard-layout" && !layout) continue;
    lines.push(
      fill(PHRASES.notes[kind], {
        merchant,
        layout,
        country: country
          ? (COUNTRIES[country.toUpperCase()] ?? country)
          : undefined,
      }),
    );
  }
  return lines.length
    ? { key: "notes", title: PHRASES.sections.notes, lines }
    : undefined;
}

function toText(sections: DescriptionSection[]): string {
  return sections
    .map((section) =>
      section.title
        ? [section.title, ...section.lines.map((line) => `- ${line}`)].join(
            "\n",
          )
        : section.lines.join(" "),
    )
    .join("\n\n");
}

function priceSection(
  facts: DealFacts,
  now: string | undefined,
): DescriptionSection | undefined {
  const lines = now ? priceContextLines(facts, now) : [];
  return lines.length
    ? { key: "price", title: PHRASES.sections.price, lines }
    : undefined;
}

function build(
  facts: DealFacts,
  limits: { bullets: number; paragraphs: number; specs: number },
  now: string | undefined,
): { type: DealType; sections: DescriptionSection[] } {
  const type = dealType(facts);
  const seed = facts.product.url.value;
  const highlights = highlightsSection(facts, seed, limits);
  const seller = sellerSection(facts, type);
  const sections = [
    introSection(facts, type, seed),
    howToSection(facts),
    priceSection(facts, now),
    highlights,
    type === "game" || type === "free-game"
      ? gameSection(facts, type, highlights?.lines ?? [])
      : undefined,
    type === "plan" ? planSection(facts) : undefined,
    specsSection(facts, limits.specs),
    seller.section,
    notesSection(facts, seller.saidThirdParty),
  ].filter((section): section is DescriptionSection => !!section);
  return { type, sections };
}

/**
 * The description, or `undefined` when the facts give nothing beyond an
 * intro line (the caller then falls back to the title's own specs).
 */
export function renderDescription(
  facts: DealFacts,
  options: {
    /** Render time; without it, no « Repères de prix » section. */
    now?: string;
  } = {},
): RenderedDescription | undefined {
  let built = build(
    facts,
    {
      bullets: LIMITS.bullets,
      paragraphs: LIMITS.paragraphs,
      specs: LIMITS.specs,
    },
    options.now,
  );
  // Too long: fewer bullets, one paragraph, the 6 first specs.
  if (toText(built.sections).length > LIMITS.totalChars) {
    built = build(
      facts,
      { bullets: 3, paragraphs: 1, specs: LIMITS.specsWhenLong },
      options.now,
    );
  }
  if (!built.sections.some((section) => section.key !== "intro"))
    return undefined;
  return {
    type: built.type,
    sections: built.sections,
    text: toText(built.sections),
    // One converter for the editor and the preview (#131).
    html: descriptionHtml(toText(built.sections)),
  };
}
