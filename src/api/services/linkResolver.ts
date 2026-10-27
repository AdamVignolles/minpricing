/**
 * Turns a pasted product link into the key the pipeline dedupes on:
 * `(sourceId, externalId)` plus a clean canonical URL. Pure, no network:
 * short links (amzn.to…) are expanded by the caller before resolving.
 */
export interface ResolvedLink {
  sourceId: string;
  externalId: string;
  canonicalUrl: string;
  host: string;
}

export class LinkError extends Error {
  constructor(
    readonly code: "invalid-url" | "unsafe-url",
    message: string,
  ) {
    super(message);
  }
}

export const MANUAL_LINK_SOURCE = "manual-link";

const SHORT_LINK_HOSTS =
  /^(?:amzn\.to|amzn\.eu|a\.co|s\.click\.aliexpress\.com)$/;

export function isShortLink(url: string): boolean {
  try {
    return SHORT_LINK_HOSTS.test(new URL(url).hostname.toLowerCase());
  } catch {
    return false;
  }
}

/** Hosts we never fetch: loopback, private ranges, link-local, bare IPs. */
function isUnsafeHost(host: string): boolean {
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host.endsWith(".local") || host.endsWith(".internal")) return true;
  if (host.includes(":")) return true;
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host);
}

export function parseLink(input: string): URL {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new LinkError("invalid-url", "Lien invalide.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new LinkError(
      "invalid-url",
      "Seuls les liens http(s) sont acceptés.",
    );
  }
  if (isUnsafeHost(url.hostname.toLowerCase())) {
    throw new LinkError("unsafe-url", "Adresse non autorisée.");
  }
  return url;
}

function hostIs(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

/** Query-less, fragment-less URL with a lowercase host and no trailing slash. */
function clean(url: URL): string {
  const path = url.pathname.replace(/\/+$/, "");
  return `${url.protocol}//${url.hostname.toLowerCase()}${path}`;
}

export function resolveLink(input: string): ResolvedLink {
  const url = parseLink(input);
  const host = url.hostname.toLowerCase().replace(/^www\./, "");

  if (/(^|\.)amazon\.(fr|com|de|es|it|co\.uk)$/.test(host)) {
    const asin = url.pathname.match(
      /\/(?:dp|gp\/product|gp\/aw\/d|d)\/([A-Z0-9]{10})(?:[/?]|$)/i,
    )?.[1];
    if (asin) {
      return {
        sourceId: "amazon",
        externalId: asin.toUpperCase(),
        canonicalUrl: `https://www.amazon.fr/dp/${asin.toUpperCase()}`,
        host,
      };
    }
  }

  if (hostIs(host, "cdiscount.com") && url.pathname.endsWith(".html")) {
    const canonical = clean(url);
    return {
      sourceId: "cdiscount",
      externalId: canonical,
      canonicalUrl: canonical,
      host,
    };
  }

  if (host === "store.steampowered.com") {
    const appId = url.pathname.match(/\/app\/(\d+)/)?.[1];
    if (appId) {
      return {
        sourceId: "steam",
        externalId: appId,
        canonicalUrl: `https://store.steampowered.com/app/${appId}`,
        host,
      };
    }
  }

  if (hostIs(host, "aliexpress.com")) {
    const itemId = url.pathname.match(/\/item\/(\d+)\.html/)?.[1];
    if (itemId) {
      return {
        sourceId: "aliexpress",
        externalId: itemId,
        canonicalUrl: `https://fr.aliexpress.com/item/${itemId}.html`,
        host,
      };
    }
  }

  const canonical = clean(url);
  return {
    sourceId: MANUAL_LINK_SOURCE,
    externalId: canonical,
    canonicalUrl: canonical,
    host,
  };
}
