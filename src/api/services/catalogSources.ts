import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import shipped from "../../../config/watch-sources.json" with { type: "json" };
import { appDir } from "./appDir.ts";

/**
 * `config/watch-sources.json`: the shops whose whole catalogue is read
 * (`CatalogService`), one entry each — no code per shop. Re-read before
 * every pass. A source is read only when `verified` (its probe passed:
 * `POST /admin/catalog/:id/probe`) **and** `enabled`.
 */
export interface CatalogSource {
  id: string;
  name: string;
  /** `sitemap-jsonld`: sitemap → product pages. `shopify`: products.json. */
  reader: "sitemap-jsonld" | "shopify";
  /** The shop's origin, « https://ocarat.com ». */
  origin: string;
  /** Sitemap URLs (or indexes); default: the ones `robots.txt` names. */
  sitemaps?: string[];
  /** Only sub-sitemaps whose URL matches (an index with blog, brands…). */
  sitemapFilter?: string;
  /** Regex a product URL must match (« /montre- »). */
  include?: string;
  /** Regex that rules a URL out. */
  exclude?: string;
  /** Regex the product's title must match to be kept (« montre »). */
  titleMustMatch?: string;
  /** Regex on the title that rules a product out (straps, boxes). */
  titleExclude?: string;
  /** Pages read per pass (default 150, at most 400). */
  perRun?: number;
  /** A read page is read again after this many hours (default 24). */
  everyHours?: number;
  /** Seconds between two requests to this shop (default 1.5, at least 1). */
  pauseSeconds?: number;
  verified?: boolean;
  enabled?: boolean;
  note?: string;
}

export interface CatalogConfig {
  /** Paris hours when passes run (default 0–6: the radar's quiet hours). */
  activeHours?: number[];
  sources: CatalogSource[];
}

export const DEFAULT_ACTIVE_HOURS = [0, 1, 2, 3, 4, 5, 6];
export const PER_RUN_DEFAULT = 150;
export const PER_RUN_MAX = 400;

const isRegex = (value: unknown) => {
  if (value === undefined) return true;
  if (typeof value !== "string") return false;
  try {
    new RegExp(value);
    return true;
  } catch {
    return false;
  }
};

/** Why an entry can't be used, or undefined when it can. */
export function sourceProblem(source: CatalogSource): string | undefined {
  if (!/^[a-z0-9-]{2,60}$/.test(source.id ?? "")) return "id invalide";
  if (!source.name) return "nom manquant";
  if (source.reader !== "sitemap-jsonld" && source.reader !== "shopify") {
    return "lecteur inconnu";
  }
  try {
    const url = new URL(source.origin);
    if (url.protocol !== "https:" || url.pathname !== "/") {
      return "origin doit être https://domaine, sans chemin";
    }
  } catch {
    return "origin invalide";
  }
  for (const key of [
    "include",
    "exclude",
    "titleMustMatch",
    "titleExclude",
    "sitemapFilter",
  ] as const) {
    if (!isRegex(source[key])) return `${key} : expression invalide`;
  }
  for (const sitemap of source.sitemaps ?? []) {
    try {
      if (new URL(sitemap).origin !== new URL(source.origin).origin) {
        return "sitemap hors du domaine de la boutique";
      }
    } catch {
      return "sitemap invalide";
    }
  }
  return undefined;
}

/**
 * Usable sources of the file; a bad entry is left out, never fatal. The
 * file under `appDir()` (Bay's persistent folder, where an edit survives
 * a deploy) wins; without one, the copy compiled into the release.
 */
export function loadCatalogConfig(file?: string): CatalogConfig {
  const usable = (raw: CatalogConfig): CatalogConfig => {
    const seen = new Set<string>();
    const sources = (Array.isArray(raw.sources) ? raw.sources : []).filter(
      (source) => {
        if (sourceProblem(source) || seen.has(source.id)) return false;
        seen.add(source.id);
        return true;
      },
    );
    return { activeHours: raw.activeHours, sources };
  };
  const path = file ?? join(appDir(), "config", "watch-sources.json");
  if (existsSync(path)) {
    try {
      return usable(JSON.parse(readFileSync(path, "utf8")) as CatalogConfig);
    } catch {
      return { sources: [] };
    }
  }
  // An explicit file that is missing is empty; the default location
  // falls back to the copy compiled into the release (a Bay release
  // doesn't carry `config/` next to it).
  return file ? { sources: [] } : usable(shipped as CatalogConfig);
}

export const perRunOf = (source: CatalogSource) =>
  Math.min(Math.max(source.perRun ?? PER_RUN_DEFAULT, 1), PER_RUN_MAX);

export const pauseMsOf = (source: CatalogSource) =>
  Math.max(source.pauseSeconds ?? 1.5, 1) * 1000;

/** Keeps the sitemap URLs that look like this shop's product pages. */
export function wantedUrls(source: CatalogSource, urls: string[]): string[] {
  const include = source.include ? new RegExp(source.include, "i") : undefined;
  const exclude = source.exclude ? new RegExp(source.exclude, "i") : undefined;
  const origin = new URL(source.origin).origin;
  const kept = new Set<string>();
  for (const url of urls) {
    try {
      const parsed = new URL(url);
      if (parsed.origin !== origin) continue;
      if (/\.(jpe?g|png|webp|gif|pdf)$/i.test(parsed.pathname)) continue;
      if (include && !include.test(url)) continue;
      if (exclude?.test(url)) continue;
      kept.add(url);
    } catch {
      // Not a URL: skip.
    }
  }
  return [...kept];
}

/** Is this product of the wanted kind, by its title? */
export function wantedTitle(source: CatalogSource, title: string): boolean {
  if (
    source.titleMustMatch &&
    !new RegExp(source.titleMustMatch, "i").test(title)
  ) {
    return false;
  }
  if (source.titleExclude && new RegExp(source.titleExclude, "i").test(title)) {
    return false;
  }
  return true;
}
