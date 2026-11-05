import { dealType } from "./dealDescription.ts";
import type { DealFacts } from "./dealFacts.ts";

/**
 * Dealabs-style titles (epic 27, #130), from the moderators' rewrites of
 * our posts (audit F17 §3):
 *
 *   [Conditions] <Type de produit> <Marque> <Modèle> - <caractéristiques> (Vendeur tiers)
 *   <Jeu> sur PC (Dématérialisé - Steam)
 *   Reconditionné : <titre> (État Correct)
 *
 * The product type found in the merchant's title moves to the front
 * (« MSI MAG A850GLS PCIE5 Alimentation modulaire » → « Alimentation
 * modulaire MSI MAG A850GLS PCIE5 »), or is added when only implied
 * (« RAM DDR5 » → « Mémoire RAM … »). Block separators become « - », a
 * trailing SKU goes (watches keep theirs: it is the model), « 32Go »
 * becomes « 32 Go », marketing words go. Only what the facts say: no
 * type, platform or condition is guessed. Kept under 140 characters by
 * `dealabsTitle()`, prefix and suffix included.
 */

/** Product types as Dealabs titles name them, most specific first. */
const TYPES: Array<{ match: RegExp; name?: string }> = [
  { match: /\balimentation modulaire\b/i },
  { match: /\balimentation pc\b/i },
  { match: /\bmachine [aà] caf[ée](?: expresso| à grains| broyeur)?\b/i },
  { match: /\bmicro-?ondes\b/i, name: "Micro-ondes" },
  { match: /\bmanette(?: de jeu)?(?: filaire| sans fil)?\b/i },
  { match: /\bcasque(?: gaming| audio| sans fil| bluetooth)?\b/i },
  { match: /\b[ée]couteurs(?: sans fil| bluetooth)?\b/i },
  { match: /\b[ée]cran pc\b/i },
  { match: /\bpc portable\b/i, name: "PC portable" },
  { match: /\bordinateur portable\b/i },
  { match: /\bmini pc\b/i, name: "Mini PC" },
  { match: /\btablette(?: tactile)?\b/i },
  { match: /\bsmartphone\b/i },
  { match: /\baspirateur(?: robot| balai| sans fil)?\b/i },
  { match: /\brobot aspirateur\b/i },
  { match: /\bfriteuse(?: sans huile)?\b/i },
  { match: /\bperceuse(?: visseuse)?(?: [àa] percussion)?\b/i },
  { match: /\bvisseuse(?: [àa] chocs)?\b/i },
  { match: /\bsouris(?: gaming| sans fil)?\b/i },
  { match: /\bclavier(?: gaming| m[ée]canique| sans fil)?\b/i },
  { match: /\bdisque dur(?: externe)?\b/i },
  { match: /\bcarte graphique\b/i },
  { match: /\bprocesseur\b/i },
  { match: /\bcarte m[èe]re\b/i },
  { match: /\bmontre(?: connect[ée]e)?\b/i },
  { match: /\benceinte(?: bluetooth| connect[ée]e)?\b/i },
  { match: /\bbarre de son\b/i },
];

/** Implied types: the title names the part, not the product type. */
const IMPLIED: Array<{ match: RegExp; name: string; unless: RegExp }> = [
  {
    match: /\b(geforce\s+r?tx|radeon\s+rx)\s*\d{3,4}\b/i,
    name: "Carte graphique",
    unless:
      /\b(carte graphique|pc portable|ordinateur|pc gamer|mini pc|pc fixe)\b/i,
  },
  {
    match: /\b(ram\b.*\bddr[345]|ddr[345]\b.*\bram)\b/i,
    name: "Mémoire RAM",
    unless:
      /^\s*m[ée]moire\b|\b(pc portable|ordinateur|smartphone|tablette)\b/i,
  },
  {
    match: /\bssd\b.*\b(nvme|m\.2|sata)\b|\b(nvme|m\.2)\b.*\bssd\b/i,
    name: "SSD",
    unless: /^\s*ssd\b|\b(pc portable|ordinateur|disque|mini pc)\b/i,
  },
];

/** Words that sell, not describe. */
const MARKETING =
  /\s*\b(professionnel(?:le)?s?|dernier mod[èe]le|haut de gamme|meilleure? vente|qualit[ée] sup[ée]rieure|premium quality)\b/gi;

const PC_STORES: Record<string, string> = {
  steam: "Steam",
  gog: "GOG",
  epic: "Epic Games Store",
};

/** Words that must precede a type for it to be the product's own. */
const NOT_OWN = /\b(pour|compatible|avec|de|du|d['’]|sans)\s*$/i;

function capitalize(text: string): string {
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}

function tidy(title: string): string {
  return title
    .replace(/\s*\|\s*/g, " - ")
    .replace(/\.\s+(?=\p{Lu})/gu, " - ")
    .replace(/(\d)(Go|To|Mo|Gb|Tb)\b/g, "$1 $2")
    .replace(MARKETING, "")
    .replace(/\s*,\s*,/g, ",")
    .replace(/\s+([,)])/g, "$1")
    .replace(/\(\s+/g, "(")
    .replace(/\s+-\s+(-\s+)+/g, " - ")
    .replace(/^[\s,–—-]+|[\s,;:–—-]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** « … Noir - CP2K16G60C36U5B » → « … Noir »: a reference code at the end. */
function dropTrailingSku(title: string): string {
  return title.replace(
    /\s+[-–—]\s+(?=[A-Z0-9-]*\d)(?=[A-Z0-9-]*[A-Z])[A-Z0-9-]{6,}$/,
    "",
  );
}

/** Moves the product type to the front, or adds an implied one. */
function typeFirst(title: string): string {
  for (const type of TYPES) {
    const found = type.match.exec(title);
    if (!found) continue;
    const index = found.index;
    if (index === 0) return title;
    const before = title.slice(0, index);
    // « Housse pour tablette », « compatible avec manette »: not ours;
    // past the first 8 words, a type is a description, not the product.
    if (NOT_OWN.test(before) || before.trim().split(/\s+/).length > 8) {
      return title;
    }
    const rest = `${before}${title.slice(index + found[0].length)}`
      .replace(/^\s*[,–—-]\s*/, "")
      .replace(/\s*,\s*,/, ",")
      .replace(/\s+,/g, ",");
    return `${capitalize(type.name ?? found[0])} ${rest.trim()}`;
  }
  for (const implied of IMPLIED) {
    if (implied.match.test(title) && !implied.unless.test(title)) {
      return `${implied.name} ${title}`;
    }
  }
  return title;
}

/** « PS4/PS5 » → « PS4 et PS5 », « Nintendo Switch 2 » → « Switch 2 »… */
const PLATFORM_NAMES: Array<[RegExp, string]> = [
  [/^PS4\s*\/\s*PS5$/i, "PS4 et PS5"],
  [/^PS[45]$/i, ""],
  [/^Nintendo Switch 2$/i, "Switch 2"],
  [/^Nintendo Switch$/i, "Switch"],
  [/^Xbox Series$/i, "Xbox Series X|S"],
  [/^Xbox( One)?$/i, ""],
  [/^PC$/i, "PC"],
  [/^Android\s*\/\s*iOS$/i, "Android et iOS"],
  [/^(Android|iOS)$/i, ""],
];

const STORE_NAMES: Record<string, string> = {
  eshop: "Nintendo eShop",
  "xbox store": "Microsoft Store",
};

/** « Planet Zoo (PS5, PlayStation Store) » → name, platform, store. */
function splitStoreTag(title: string): {
  name: string;
  platform?: string;
  store?: string;
} {
  const tag = title.match(/\s*\(([^()]+)\)\s*$/);
  if (!tag) return { name: title };
  const [first, second] = tag[1].split(/\s*,\s*/);
  const known = PLATFORM_NAMES.find(([match]) => match.test(first));
  if (!known) return { name: title };
  const platform = known[1] || first.toUpperCase().replace(/^XBOX/, "Xbox");
  const store = second
    ? (STORE_NAMES[second.toLowerCase()] ?? second)
    : undefined;
  return { name: title.slice(0, tag.index).trim(), platform, store };
}

function gameTitle(facts: DealFacts, type: "game" | "free-game"): string {
  const raw = tidy(facts.product.title.value);
  if (/\(d[ée]mat[ée]rialis[ée]/i.test(raw)) return raw;
  const tagged = splitStoreTag(raw);
  let { platform, store } = tagged;
  const pcStore = PC_STORES[facts.sourceId];
  const platforms = facts.game?.platforms?.value ?? [];
  if (!platform && pcStore) platform = "PC";
  else if (!platform && facts.sourceId === "nintendo") platform = "Switch";
  else if (!platform && facts.sourceId === "playstation") {
    platform = platforms.find((p) => /^PS[45]$/i.test(p))?.toUpperCase();
  } else if (!platform && facts.sourceId === "xbox") platform = "Xbox";
  else if (!platform && platforms.some((p) => /windows|pc/i.test(p))) {
    platform = "PC";
  }
  store ??=
    pcStore ??
    {
      nintendo: "Nintendo eShop",
      playstation: "PlayStation Store",
      xbox: "Microsoft Store",
    }[facts.sourceId] ??
    (facts.sourceId === "freegames"
      ? undefined
      : facts.product.merchant?.value);
  let name = tagged.name;
  if (type === "free-game" && !/\bgratuit\b/i.test(name)) name += " gratuit";
  const where =
    platform && !/\bsur (pc|ps[45]|xbox|switch)\b/i.test(name)
      ? ` sur ${platform}`
      : "";
  return `${name}${where} (Dématérialisé${store ? ` - ${store}` : ""})`;
}

/** Dealabs refuses titles longer than this. */
export const DEALABS_TITLE_MAX = 140;

/**
 * Fits a merchant title into Dealabs' 140 characters without cutting a
 * word in half: whole trailing segments ("…, avec prise en charge du
 * Wi-Fi 6", "– Clavier AZERTY") are dropped first, and only a single
 * over-long segment is cut, at a word boundary.
 */
export function dealabsTitle(title: string, max = DEALABS_TITLE_MAX): string {
  const clean = title.replace(/\s+/g, " ").trim();
  if (clean.length <= max) {
    return clean;
  }
  // Split points that end a meaningful part of a product title.
  const cuts = [...clean.matchAll(/\s[-–—|]\s|,\s|\s\(|:\s/g)]
    .map((match) => match.index)
    .filter((index): index is number => index !== undefined && index <= max);
  const lastCut = cuts.at(-1);
  if (lastCut !== undefined && lastCut >= max * 0.4) {
    return clean.slice(0, lastCut).trim();
  }
  const words = clean.slice(0, max + 1).split(" ");
  words.pop();
  return words.join(" ").replace(/[\s,;:–—-]+$/, "");
}

const WATCH_SOURCES = new Set(["ocarat", "timeshop24"]);

/** The title to post on Dealabs, from the deal's facts. */
export function buildDealTitle(facts: DealFacts, max = 140): string {
  const type = dealType(facts);
  if (type === "game" || type === "free-game") {
    return dealabsTitle(gameTitle(facts, type), max);
  }

  let prefix = "";
  let suffix = "";
  if (
    type === "plan" &&
    facts.planTerms?.value.some((term) => /nouveaux? clients?/i.test(term)) &&
    !/nouveaux? clients?/i.test(facts.product.title.value)
  ) {
    prefix = "[Nouveaux clients] ";
  }
  const condition = facts.product.condition?.value;
  if (condition === "refurbished" || condition === "used") {
    const state = facts.specs?.value.find((spec) =>
      /^[ée]tat$/i.test(spec.label),
    )?.value;
    prefix += condition === "refurbished" ? "Reconditionné : " : "Occasion : ";
    if (state) suffix += ` (État ${state})`;
  }
  if (facts.offer?.coupon) suffix += " (Via Coupon)";
  if (facts.seller?.soldByMerchant?.value === false)
    suffix += " (Vendeur tiers)";

  let core = facts.product.title.value;
  core = core.replace(/^(reconditionn[ée]e?|occasion)\s*[:-]?\s*/i, "");
  core = tidy(core);
  if (!WATCH_SOURCES.has(facts.sourceId) && facts.categoryId !== "montres") {
    core = dropTrailingSku(core);
  }
  if (type === "product") core = typeFirst(core);
  // « Reconditionné : PC portable … »: the type keeps its own case.
  if (!prefix) core = capitalize(core);

  const room = max - prefix.length - suffix.length;
  return `${prefix}${dealabsTitle(core, Math.max(room, 40))}${suffix}`
    .slice(0, max)
    .trim();
}
