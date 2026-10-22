import { describe, expect, test } from "vitest";

import { parseReviewTooltip } from "../src/api/collectors/SteamCollector.ts";
import { qualityIssue } from "../src/api/services/qualityGate.ts";
import {
  dropSameListings,
  sameListingKey,
} from "../src/api/services/sameListing.ts";

describe("parseReviewTooltip", () => {
  test("reads percent and count from a French Steam search row", () => {
    const row =
      '<span class="search_review_summary positive" data-tooltip-html="très positives&lt;br&gt;84 % des 6,902 évaluations des utilisateurs et utilisatrices pour ce jeu sont positives.">';
    expect(parseReviewTooltip(row)).toEqual({ percent: 84, count: 6902 });
  });

  test("no tooltip, no reviews", () => {
    expect(parseReviewTooltip('<span class="title">Foo</span>')).toBe(
      undefined,
    );
  });
});

describe("qualityIssue — Steam", () => {
  test("an unknown game is rejected, a popular one kept", () => {
    expect(
      qualityIssue({
        title: "Slope Rivals",
        sourceId: "steam",
        productRating: 5,
        productReviewCount: 3,
      }),
    ).toMatch(/peu connu/);
    expect(
      qualityIssue({
        title: "Sifu",
        sourceId: "steam",
        productRating: 4.6,
        productReviewCount: 60000,
      }),
    ).toBe(undefined);
  });
});

describe("sameListingKey", () => {
  const base = { sourceId: "amazon", currentPrice: 64.99 };

  test("colour variants of one product share a key", () => {
    const black = {
      ...base,
      title: "Amazon Echo Dot Max (nouvelle génération) : enceinte, Graphite",
    };
    const white = {
      ...base,
      title: "Amazon Echo Dot Max (nouvelle génération) : enceinte, Blanc",
    };
    expect(sameListingKey(black)).toBe(sameListingKey(white));
    expect(dropSameListings([black, white])).toEqual([black]);
  });

  test("another price or platform is another deal", () => {
    const ps5 = { ...base, title: "NBA 2K25 (PS5) Jeu PS5 Sport" };
    const xbox = { ...base, title: "NBA 2K25 (XBOX SERIE X) Jeu Sport" };
    expect(sameListingKey(ps5)).not.toBe(sameListingKey(xbox));
    expect(sameListingKey(ps5)).not.toBe(
      sameListingKey({ ...ps5, currentPrice: 49.99 }),
    );
  });
});

describe("qualityIssue — saving floor", () => {
  test("a tiny saving is rejected, a free game is not", () => {
    expect(
      qualityIssue({
        title: "IKEA ODLINGSGRÄNS Bouton",
        sourceId: "ikea",
        price: 3,
        listPrice: 6,
      }),
    ).toMatch(/économie trop faible/);
    expect(
      qualityIssue({
        title: "TerraScape (PC, Epic Games Store)",
        sourceId: "epic",
        price: 0,
        listPrice: 15.29,
      }),
    ).toBe(undefined);
    expect(
      qualityIssue({
        title: "PARKSIDE Sécateur",
        sourceId: "lidl",
        price: 13.99,
        listPrice: 34.99,
      }),
    ).toBe(undefined);
  });
});
