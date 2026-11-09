import { amazonRawDeal } from "../collectors/AmazonCollector.ts";
import {
  isAmazonRobotCheck,
  parseAmazonProductHtml,
} from "../collectors/amazonProductHtml.ts";
import type { RawDeal } from "../collectors/DealSource.ts";
import { amazonAsin } from "./keepa.ts";

/**
 * « Lire dans DealRadar » (epic 33): a watched product's page as the owner
 * sees it in their own browser, sent to DealRadar when the server's read
 * meets Amazon's robot check. The server never asks Amazon anything here:
 * this only reads what the owner's normal visit showed, with the same
 * parser as the collection. Pure.
 */

/** Larger than any product page; a page past it is refused. */
export const PAGE_READ_MAX_BYTES = 5_000_000;

export type PageReadResult =
  | { ok: true; raw: RawDeal }
  | { ok: false; reason: string };

export function readSentPage(
  link: { sourceId: string; externalId: string },
  url: string,
  html: string,
): PageReadResult {
  if (link.sourceId !== "amazon") {
    return {
      ok: false,
      reason: "La lecture depuis votre navigateur ne sert que pour Amazon.fr.",
    };
  }
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    // Not a URL: refused below.
  }
  if (!/(^|\.)amazon\.fr$/i.test(host)) {
    return { ok: false, reason: "Cette page n'est pas sur Amazon.fr." };
  }
  const asin = amazonAsin(url);
  if (asin !== link.externalId) {
    return {
      ok: false,
      reason: `Cette page n'est pas celle du produit suivi (${link.externalId}).`,
    };
  }
  if (html.length > PAGE_READ_MAX_BYTES) {
    return { ok: false, reason: "Page trop volumineuse." };
  }
  if (isAmazonRobotCheck(html)) {
    return {
      ok: false,
      reason:
        "La page envoyée est la vérification anti-robot d'Amazon : remplissez-la sur Amazon, puis cliquez de nouveau sur le bouton depuis la fiche produit.",
    };
  }
  const read = parseAmazonProductHtml(html);
  if (!read) {
    return {
      ok: false,
      reason:
        "Prix ou titre introuvable sur cette page (produit indisponible, ou mise en page inconnue).",
    };
  }
  return { ok: true, raw: amazonRawDeal(asin, read) };
}
