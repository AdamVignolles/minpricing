import { describe, expect, it } from "vitest";

import {
  assessDealPage,
  type DealPageSnapshot,
  euroAmounts,
} from "../src/api/services/dealPageCheck.ts";

const page = (overrides: Partial<DealPageSnapshot>): DealPageSnapshot => ({
  status: 200,
  title: "Produit",
  text: "",
  prices: [],
  ...overrides,
});

describe("euroAmounts", () => {
  it("reads French, English and thousands formats", () => {
    expect(euroAmounts("Prix : 1 299,99 € au lieu de 1.499,00 €")).toEqual([
      1299.99, 1499,
    ]);
    expect(euroAmounts("€9.99 · 24,49 € · 9,99 €/mois · 5 EUR")).toEqual([
      9.99, 24.49, 9.99, 5,
    ]);
  });
});

describe("assessDealPage", () => {
  it("passes when our price is on the page", () => {
    expect(
      assessDealPage(page({ prices: [3.99, 1.99] }), { currentPrice: 1.99 }),
    ).toEqual({
      ok: true,
      matchedPrice: 1.99,
    });
  });

  it("rejects a shop in maintenance (GOG, 2026-10-21)", () => {
    const verdict = assessDealPage(
      page({ status: 503, title: "GOG.com | Maintenance in progress" }),
      { currentPrice: 1.99 },
    );
    expect(verdict.ok).toBe(false);
  });

  it("rejects a missing page", () => {
    expect(assessDealPage(page({ status: 404 }), { currentPrice: 10 }).ok).toBe(
      false,
    );
  });

  it("rejects an out-of-stock product, schema.org first", () => {
    expect(
      assessDealPage(
        page({ availability: "https://schema.org/OutOfStock", prices: [10] }),
        {
          currentPrice: 10,
        },
      ).ok,
    ).toBe(false);
    expect(
      assessDealPage(
        page({ text: "Actuellement indisponible.", prices: [10] }),
        {
          currentPrice: 10,
        },
      ).ok,
    ).toBe(false);
  });

  it("trusts an in-stock schema over a stray out-of-stock phrase", () => {
    expect(
      assessDealPage(
        page({
          availability: "https://schema.org/InStock",
          text: "Coloris noir : rupture de stock",
          prices: [10],
        }),
        { currentPrice: 10 },
      ).ok,
    ).toBe(true);
  });

  it("rejects a changed price and says what the page shows", () => {
    const verdict = assessDealPage(page({ prices: [29.99, 39.99] }), {
      currentPrice: 24.49,
    });
    expect(verdict).toEqual({
      ok: false,
      reason: "le prix a changé : 24.49 € attendu, la page affiche 29.99 €",
    });
  });

  it("rejects a page where no price can be read", () => {
    expect(
      assessDealPage(page({ prices: [] }), { currentPrice: 24.49 }).ok,
    ).toBe(false);
  });

  it("does not require a price for a free deal", () => {
    expect(
      assessDealPage(page({ prices: [19.99] }), { currentPrice: 0 }).ok,
    ).toBe(true);
  });
});
