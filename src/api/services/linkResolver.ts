/**
 * Turns a pasted product link into the deal key collection uses, so a
 * linked product and a collected one are the same deal: `(sourceId,
 * externalId)` plus a canonical URL with no tracking or affiliate params.
 *
 * Pure apart from short-link expansion, whose `fetch` is injected. Never
 * opens a Dealabs link (its click-outs count as visits, and a Dealabs
 * thread is not a shop).
 */

export interface LinkTarget {
  sourceId: string;
  /** The shop's id for the product: ASIN, item id, appid, page URL. */
  externalId: string;
  canonicalUrl: string;
}

export interface SupportedShop {
  sourceId: string;
  label: string;
  /** Host names the shop's product pages live on. */
  hosts: RegExp;
  /** What to paste, shown under the console's link field. */
  example: string;
  match(url: URL): LinkTarget | undefined;
}

export type LinkRefusalReason =
  | "invalid"
  | "dealabs"
  | "unsupported"
  | "not-a-product"
  | "unreadable";

export type LinkResolution =
  | ({ ok: true; label: string } & LinkTarget)
  | { ok: false; reason: LinkRefusalReason; message: string };

const ASIN_PATH =
  /\/(?:dp|gp\/product|gp\/aw\/d|exec\/obidos\/ASIN|o\/ASIN)\/([A-Z0-9]{10})(?:[/?]|$)/i;

export const SUPPORTED_SHOPS: SupportedShop[] = [
  {
    sourceId: "amazon",
    label: "Amazon.fr",
    hosts: /(^|\.)amazon\.fr$/,
    example: "https://www.amazon.fr/dp/B0…",
    match(url) {
      const asin = url.pathname.match(ASIN_PATH)?.[1]?.toUpperCase();
      return asin
        ? {
            sourceId: "amazon",
            externalId: asin,
            canonicalUrl: `https://www.amazon.fr/dp/${asin}`,
          }
        : undefined;
    },
  },
  {
    sourceId: "cdiscount",
    label: "Cdiscount",
    hosts: /(^|\.)cdiscount\.com$/,
    example: "https://www.cdiscount.com/…/f-123-abc.html",
    match(url) {
      // Collection keys Cdiscount deals by their page URL (no sku field
      // anywhere else): same origin, same path, nothing after.
      if (!/\/f-\d+-[a-z0-9]+\.html$/i.test(url.pathname)) return undefined;
      const canonicalUrl = `https://www.cdiscount.com${url.pathname}`;
      return { sourceId: "cdiscount", externalId: canonicalUrl, canonicalUrl };
    },
  },
  {
    sourceId: "aliexpress",
    label: "AliExpress",
    hosts: /(^|\.)aliexpress\.(com|fr|us)$/,
    example: "https://fr.aliexpress.com/item/100500….html",
    match(url) {
      const id = url.pathname.match(/\/(?:item|i)\/(\d{6,})\.html/)?.[1];
      return id
        ? {
            sourceId: "aliexpress",
            externalId: id,
            canonicalUrl: `https://fr.aliexpress.com/item/${id}.html`,
          }
        : undefined;
    },
  },
  {
    sourceId: "steam",
    label: "Steam",
    hosts: /^store\.steampowered\.com$/,
    example: "https://store.steampowered.com/app/1145350",
    match(url) {
      const id = url.pathname.match(/^\/app\/(\d+)/)?.[1];
      return id
        ? {
            sourceId: "steam",
            externalId: id,
            canonicalUrl: `https://store.steampowered.com/app/${id}`,
          }
        : undefined;
    },
  },
];

/** Hosts that only redirect to a shop: followed, never kept. */
const SHORT_HOSTS =
  /^(amzn\.to|amzn\.eu|a\.co|s\.click\.aliexpress\.com|click\.aliexpress\.com|a\.aliexpress\.com|bit\.ly|tinyurl\.com|t\.co|s\.team)$/;

export const MAX_REDIRECTS = 5;
export const REDIRECT_TIMEOUT_MS = 8_000;

const supportedList = () =>
  SUPPORTED_SHOPS.map((shop) => shop.label).join(", ");

const refuse = (
  reason: LinkRefusalReason,
  message: string,
): LinkResolution => ({ ok: false, reason, message });

const parseUrl = (input: string): URL | undefined => {
  const trimmed = input.trim();
  // A link copied without its scheme ("amazon.fr/dp/…").
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  try {
    const url = new URL(withScheme);
    return url.protocol === "https:" || url.protocol === "http:"
      ? url
      : undefined;
  } catch {
    return undefined;
  }
};

const hostOf = (url: URL) => url.hostname.toLowerCase().replace(/\.$/, "");

const shopFor = (url: URL) =>
  SUPPORTED_SHOPS.find((shop) => shop.hosts.test(hostOf(url)));

/**
 * Matches a URL against the registry, without any network call. Shop
 * found but no product id in the path → `not-a-product` (a search or
 * category page).
 */
export function matchLink(url: URL): LinkResolution {
  const host = hostOf(url);
  if (/(^|\.)dealabs\.com$/.test(host)) {
    return refuse(
      "dealabs",
      "C'est un lien Dealabs : collez le lien de la boutique (ouvrez le deal et copiez l'adresse de la page du produit).",
    );
  }
  const shop = shopFor(url);
  if (!shop) {
    return refuse(
      "unsupported",
      `Boutique non prise en charge (${host}). Boutiques acceptées : ${supportedList()}.`,
    );
  }
  const target = shop.match(url);
  if (!target) {
    return refuse(
      "not-a-product",
      `Ce lien ${shop.label} ne mène pas à une fiche produit (exemple attendu : ${shop.example}).`,
    );
  }
  return { ok: true, label: shop.label, ...target };
}

/** A shop URL written in a page that redirects by script or meta tag. */
const shopUrlInBody = (body: string): URL | undefined => {
  for (const raw of body.match(/https?:\/\/[^\s"'<>\\]+/g) ?? []) {
    const url = parseUrl(raw.replace(/&amp;/g, "&"));
    if (url && shopFor(url)?.match(url)) return url;
  }
  return undefined;
};

/**
 * Follows a short link (amzn.to, s.click.aliexpress.com, bit.ly…) hop by
 * hop with `redirect: "manual"`, at most {@link MAX_REDIRECTS} hops and
 * {@link REDIRECT_TIMEOUT_MS} each. Stops at the first hop that is a shop
 * page (never loads the shop itself) or a Dealabs link. `undefined` when
 * the chain can't be followed.
 */
export async function expandShortLink(
  url: URL,
  fetcher: typeof fetch = fetch,
): Promise<URL | undefined> {
  let current = url;
  for (let hop = 0; hop < MAX_REDIRECTS; hop++) {
    if (!SHORT_HOSTS.test(hostOf(current))) return current;
    let response: Response;
    try {
      response = await fetcher(current.toString(), {
        redirect: "manual",
        signal: AbortSignal.timeout(REDIRECT_TIMEOUT_MS),
        headers: { "user-agent": "Mozilla/5.0 (DealRadar link check)" },
      });
    } catch {
      return undefined;
    }
    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location) {
      try {
        current = new URL(location, current);
      } catch {
        return undefined;
      }
      if (/(^|\.)dealabs\.com$/.test(hostOf(current))) return current;
      continue;
    }
    if (response.ok) {
      // Some shorteners answer 200 with a script/meta redirect.
      const body = await response.text().catch(() => "");
      return shopUrlInBody(body);
    }
    return undefined;
  }
  return SHORT_HOSTS.test(hostOf(current)) ? undefined : current;
}

/**
 * Pasted text → shop, product id and canonical URL, or a refusal saying
 * in French what is wrong and which shops are accepted.
 */
export async function resolveLink(
  input: string,
  fetcher: typeof fetch = fetch,
): Promise<LinkResolution> {
  const url = parseUrl(input);
  if (!url || !url.hostname.includes(".")) {
    return refuse("invalid", "Ce n'est pas un lien (https://…).");
  }
  if (!SHORT_HOSTS.test(hostOf(url))) return matchLink(url);
  const expanded = await expandShortLink(url, fetcher);
  if (!expanded) {
    return refuse(
      "unreadable",
      `Le lien court ${hostOf(url)} n'a pas pu être suivi. Collez le lien complet de la fiche produit.`,
    );
  }
  return matchLink(expanded);
}
