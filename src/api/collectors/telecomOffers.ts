/**
 * Pure parsers for operators' mobile plan / box offers (Orange, Free,
 * Bouygues Telecom, RED by SFR). No network here: each takes what the
 * operator's own page or API returns, so they can be tested against
 * captured payloads. Every price is per month.
 */

export interface TelecomOffer {
  /** Stable per operator offer (URL, gencode, data volume…). */
  externalId: string;
  /** Plan name without the operator ("Série Spéciale 130Go 5G+"). */
  name: string;
  /** Monthly price paid now. */
  price: number;
  /**
   * Normal monthly price (struck on the page / price after the promo),
   * only when strictly above {@link price}.
   */
  regularPrice?: number;
  url: string;
  /** Plain-French facts: data, network, commitment, conditions. */
  description?: string;
  kind: "mobile" | "box" | "pack";
}

const frPrice = (raw: string) =>
  Number(raw.replace(/\s/g, "").replace(",", "."));

/** Minimal HTML → text lines (no DOM available server-side). */
export function htmlToLines(html: string): string[] {
  return (
    html
      .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, "")
      // Block boundaries only: inline tags (<span>, <sup>…) split prices
      // like "20,99 € /mois" across nodes.
      .replace(/<(br|\/p|\/div|\/li|\/h\d|\/a|\/del|\/s)\b[^>]*>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;|&#160;/g, " ")
      .replace(/&euro;/g, "€")
      .replace(/&#0?39;|&rsquo;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, "&")
      .split("\n")
      .map((line) => line.replace(/\s+/g, " ").trim())
      .filter(Boolean)
  );
}

/**
 * Orange "bons plans" page: one `card-produit` per promotion. Lines read
 * "Bon plan · Série Spéciale 130Go 5G+ · <pitch> · 20,99 € /mois ·
 * 24,99 € · Offre sans engagement". Only mobile plans, internet boxes and
 * packs are kept — not streaming add-ons, insurance or phones.
 */
export function parseOrangePromos(html: string): TelecomOffer[] {
  const offers: TelecomOffer[] = [];
  const chunks = html.split(/class="card-produit/).slice(1);
  for (const chunk of chunks) {
    const href = chunk.match(/href="([^"]+)"/)?.[1];
    if (!href) continue;
    const url = href.startsWith("http")
      ? href
      : `https://boutique.orange.fr${href}`;
    const path = new URL(url).pathname;
    const kind: TelecomOffer["kind"] | undefined = path.startsWith(
      "/internet-mobile/",
    )
      ? "pack"
      : path.startsWith("/internet/")
        ? "box"
        : /^\/mobile\/offre|cheat-code|forfait/.test(path)
          ? "mobile"
          : undefined;
    if (!kind) continue;

    // Card body only: the chunk also runs into the next section's heading.
    const all = htmlToLines(`<div ${chunk}`);
    const lines = all.slice(
      0,
      Math.max(
        0,
        all.findIndex((line) => /^Découvrir\b/i.test(line)),
      ) || all.length,
    );
    // Price as "20,99 € /mois", or split "20,99€" + "/mois".
    const priceIndex = lines.findIndex(
      (line, index) =>
        /^\d+[,.]\d{2}\s*€\s*\/\s*mois$/i.test(line) ||
        (/^\d+[,.]\d{2}\s*€$/.test(line) &&
          /^\/\s*mois$/i.test(lines[index + 1] ?? "")),
    );
    if (priceIndex < 1) continue;
    const price = frPrice(lines[priceIndex].match(/(\d+[,.]\d{2})/)?.[1] ?? "");
    const after = /mois/i.test(lines[priceIndex])
      ? priceIndex + 1
      : priceIndex + 2;
    // The struck normal price follows directly, alone on its line.
    const struck = lines[after]?.match(/^(\d+[,.]\d{2})\s*€$/)?.[1];
    const regular = struck ? frPrice(struck) : undefined;
    // Name: the line right after the badge ("Bon plan", "Offre 18-26 ans").
    const name = lines[1] ?? lines[0];
    const facts = lines
      .slice(struck ? after + 1 : after)
      .filter((line) => !/^Voir conditions?\.?$/i.test(line))
      .slice(0, 3);
    offers.push({
      externalId: path,
      name,
      price,
      regularPrice: regular && regular > price ? regular : undefined,
      url,
      description: [lines[2], ...facts].filter(Boolean).join("\n"),
      kind,
    });
  }
  return offers;
}

interface FreePlan {
  id?: number;
  name?: string;
  description?: string;
  price?: number;
  "5g"?: boolean;
  nationalData?: { fairuse?: number };
  discount?: Array<{ type?: string; amount?: number; duration?: number }>;
}

/**
 * Free Mobile "bons plans" page (`__NEXT_DATA__` → pageProps): the plans
 * (`serieFree`, `free5g`…) with their price in cents. Free's discounts
 * all depend on a condition (having a Freebox, switching operator…), so
 * they are stated in the description, never applied to the price: a deal
 * must be what anyone pays.
 */
export function parseFreePlans(nextData: unknown): TelecomOffer[] {
  const props = (
    nextData as { props?: { pageProps?: Record<string, unknown> } }
  )?.props?.pageProps;
  if (!props) return [];
  const offers: TelecomOffer[] = [];
  for (const value of Object.values(props)) {
    const plan = value as FreePlan;
    if (!plan || typeof plan !== "object" || !plan.name || !plan.price)
      continue;
    const conditional = (plan.discount ?? [])
      .filter((d) => d.amount && d.amount > 0)
      .map((d) => {
        const who =
          d.type === "migration"
            ? "en portabilité"
            : d.type?.startsWith("freebox")
              ? "pour les abonnés Freebox"
              : "sous conditions";
        const howLong =
          d.duration && d.duration > 0 ? ` pendant ${d.duration} mois` : "";
        return `- Remise de ${((d.amount ?? 0) / 100).toFixed(2).replace(".", ",")} €/mois ${who}${howLong}`;
      });
    offers.push({
      externalId: `free-${plan.id ?? plan.name}`,
      name: plan.name.replace(/^Forfait\s+/i, ""),
      price: plan.price / 100,
      url: "https://mobile.free.fr/",
      description: [
        // `description` states the data ("160Go NAT / 30Go EUV / 5G");
        // `nationalData.fairuse` is a fair-use cap, not the plan's data.
        plan.description,
        "- Sans engagement",
        ...[...new Set(conditional)].slice(0, 3),
      ]
        .filter(Boolean)
        .join("\n"),
      kind: "mobile",
    });
  }
  return offers;
}

interface BouyguesPlanHit {
  gencode?: string;
  nom?: string;
  gammeCommerciale?: string;
  libelleEnveloppeData?: string;
  connectivite?: string;
  url?: string;
  prix?: { initial?: number; final?: number };
  typePrix?: string;
}

/**
 * Bouygues Telecom's public search API (`plans` index): SIM-only plans
 * (`forfait_sans_mobile`) with their normal (`initial`) and current
 * (`final`) monthly price.
 */
export function parseBouyguesPlans(apiResponse: unknown): TelecomOffer[] {
  const results = (
    apiResponse as {
      results?: Array<{ indexUid?: string; hits?: BouyguesPlanHit[] }>;
    }
  )?.results;
  const hits = results?.find((r) => r.indexUid === "plans")?.hits ?? [];
  return hits
    .filter(
      (hit) =>
        hit.gammeCommerciale === "forfait_sans_mobile" &&
        hit.typePrix === "MENSUEL" &&
        hit.nom &&
        hit.prix?.final &&
        // "B.iG" plans are reserved for Bbox customers (box + plan bundle):
        // not a price anyone can get.
        !/\bBiG\b/i.test(hit.nom),
    )
    .map((hit) => {
      const price = hit.prix?.final as number;
      const initial = hit.prix?.initial;
      return {
        externalId: `bouygues-${hit.gencode ?? hit.url}`,
        name: (hit.nom as string).replace(/\s*SIM seule\s*$/i, "").trim(),
        price,
        regularPrice: initial && initial > price ? initial : undefined,
        url: hit.url
          ? `https://www.bouyguestelecom.fr/forfaits-mobiles/${hit.url}`
          : "https://www.bouyguestelecom.fr/forfaits-mobiles",
        description: [
          hit.libelleEnveloppeData ? `- ${hit.libelleEnveloppeData}` : null,
          hit.connectivite
            ? `- Réseau ${hit.connectivite.toUpperCase()}`
            : null,
          "- Forfait SIM seule",
        ]
          .filter(Boolean)
          .join("\n"),
        kind: "mobile" as const,
      };
    });
}

/**
 * B&YOU (Bouygues' no-commitment brand) special series, stated in plain
 * text on its page: "Série spéciale B&YOU 20Go 5G dont 20Go valables en
 * Europe/DOM à 9,99€/mois".
 */
export function parseByouSeries(html: string): TelecomOffer[] {
  const text = htmlToLines(html).join("\n");
  const seen = new Set<string>();
  const offers: TelecomOffer[] = [];
  for (const match of text.matchAll(
    /Série spéciale B&YOU\s+([^\n]+?)\s+à\s+(\d+[,.]\d{2})\s*€\s*\/\s*mois/gi,
  )) {
    const name = `B&YOU ${match[1].replace(/\s+dont\s+.*$/i, "").trim()}`;
    if (seen.has(name)) continue;
    seen.add(name);
    offers.push({
      externalId: `byou-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
      name: `Série spéciale ${name}`,
      price: frPrice(match[2]),
      url: "https://www.bouyguestelecom.fr/forfaits-mobiles/sans-engagement",
      description: [`- ${match[1].trim()}`, "- Sans engagement"].join("\n"),
      kind: "mobile",
    });
  }
  return offers;
}

/**
 * RED by SFR plan configurator: the page embeds `serviceOffer = {…}` with
 * every data option and its monthly price (cents), e.g. 40Go → 999.
 */
export function parseRedPlans(html: string): TelecomOffer[] {
  const start = html.indexOf("serviceOffer = {");
  if (start < 0) return [];
  const open = html.indexOf("{", start);
  let depth = 0;
  let end = open;
  for (; end < html.length; end++) {
    if (html[end] === "{") depth++;
    else if (html[end] === "}" && --depth === 0) break;
  }
  let config: {
    datanat?: Array<{
      enabled?: boolean;
      label?: string;
      volume?: number;
      net5g?: string;
      pricePerMonthWithDiscount?: number;
    }>;
  };
  try {
    config = JSON.parse(html.slice(open, end + 1))?.data
      ?.redMobileOfferConfiguration;
  } catch {
    return [];
  }
  return (config?.datanat ?? [])
    .filter(
      (option) =>
        option.enabled && option.label && option.pricePerMonthWithDiscount,
    )
    .map((option) => {
      const fiveG = option.net5g === "included";
      return {
        externalId: `red-${option.volume ?? option.label}`,
        name: `RED ${option.label}${fiveG ? " 5G" : ""}`,
        price: (option.pricePerMonthWithDiscount as number) / 100,
        url: "https://www.red-by-sfr.fr/forfaits-mobiles/",
        description: [
          `- ${option.label} d'internet en France${fiveG ? ", 5G incluse" : ""}`,
          "- Appels, SMS et MMS illimités",
          "- Sans engagement",
        ].join("\n"),
        kind: "mobile" as const,
      };
    });
}

/**
 * Sosh's plans page, as rendered text (the shop is a client-side app
 * behind an Orange login redirect, so it is read in the browser): one
 * block per plan, from "Forfait …" to "Voir le détail".
 */
export function parseSoshPlans(text: string): TelecomOffer[] {
  const offers: TelecomOffer[] = [];
  const blocks = text.split(/\n(?=Forfait [^\n]+\n[\d,]+\s?€ par mois)/);
  for (const block of blocks.slice(1)) {
    const lines = block
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    const name = lines[0];
    const price = Number(
      lines[1]?.match(/^([\d,]+)\s?€/)?.[1]?.replace(",", "."),
    );
    if (!name || !Number.isFinite(price) || price <= 0) continue;
    const end = lines.findIndex((line) => line.startsWith("Voir le détail"));
    const facts = lines
      .slice(2, end > 0 ? end : undefined)
      .filter(
        (line) => !/€ \/mois|^Sélectionner|taux 0%|Financement/i.test(line),
      )
      .map((line) => `- ${line}`);
    const volume = name.match(/(\d+)\s?Go/)?.[1];
    offers.push({
      externalId: `sosh-${volume ?? name.toLowerCase().replace(/\W+/g, "-")}${/5G/.test(name) ? "-5g" : ""}`,
      name: name.replace(/^Forfait\s+/, "Forfait Sosh "),
      price,
      url: "https://shop.sosh.fr/mobile/forfaits-mobiles",
      description: [...facts, "- Sans engagement"].join("\n"),
      kind: "mobile",
    });
  }
  return offers;
}
