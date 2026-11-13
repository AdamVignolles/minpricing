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
  /** Date of the file (« 2026-11-13 »): the later of two copies wins. */
  updated?: string;
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
 * The configuration in force: the copy shipped in the code (bundled, so a
 * deploy always brings it), unless the file under `appDir()` — edited on
 * the server — carries a later `updated` date.
 */
function rawConfig(file: string | undefined): CatalogConfig {
  const bundled = shipped as CatalogConfig;
  const path = file ?? join(appDir(), "config", "watch-sources.json");
  if (!existsSync(path)) return file ? { sources: [] } : bundled;
  const local = JSON.parse(readFileSync(path, "utf8")) as CatalogConfig;
  if (file) return local;
  return (local.updated ?? "") > (bundled.updated ?? "") ? local : bundled;
}

/** Usable sources of the file; a bad entry is left out, never fatal. */
export function loadCatalogConfig(file?: string): CatalogConfig {
  try {
    const raw = rawConfig(file);
    const seen = new Set<string>();
    const sources = (Array.isArray(raw.sources) ? raw.sources : []).filter(
      (source) => {
        if (sourceProblem(source) || seen.has(source.id)) return false;
        seen.add(source.id);
        return true;
      },
    );
    return { activeHours: raw.activeHours, sources };
  } catch {
    return { sources: [] };
  }
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

const fold = (value: string) =>
  value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

/**
 * A children's watch, by its title or its « Genre » line: left out of the
 * catalogue and of the price watch (owner's decision, 13/11/2026).
 */
export function isKidsProduct(
  title: string,
  specs: Array<{ label: string; value: string }> = [],
): boolean {
  if (
    /\b(enfants?|junior|kids?|gar[cç]ons?|fillettes?|bebes?|ado|adolescents?)\b/.test(
      fold(title),
    )
  ) {
    return true;
  }
  const genre = specs.find((spec) =>
    /^(genre|sexe|pour|public)/.test(fold(spec.label)),
  );
  return (
    !!genre && /enfant|junior|kids?|garcon|fille\b/.test(fold(genre.value))
  );
}

/**
 * A watch the catalogue leaves out (owner's decisions, 13/11/2026), and
 * why: a children's watch, a second-hand one (title or the page's
 * `itemCondition`), a connected watch (title or « Mouvement » line).
 */
export function excludedProduct(
  title: string,
  specs: Array<{ label: string; value: string }> = [],
  condition?: string,
): "kids" | "used" | "connected" | undefined {
  if (isKidsProduct(title, specs)) return "kids";
  const text = fold(title);
  if (
    condition === "used" ||
    condition === "refurbished" ||
    /\b(d'occasion|occasion|seconde main|reconditionnee?s?|pre-?owned|vintage d'occasion)\b/.test(
      text,
    )
  ) {
    return "used";
  }
  const movement = specs.find((spec) =>
    /mouvement|mecanisme|type de montre/.test(fold(spec.label)),
  );
  if (
    /\b(connectee?s?|smart ?watch|montre intelligente|hybride connectee)\b/.test(
      text,
    ) ||
    (!!movement && /connect|smart/.test(fold(movement.value)))
  ) {
    return "connected";
  }
  return undefined;
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
