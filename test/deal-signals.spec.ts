import { describe, expect, test } from "vitest";

import {
  dealabsSignal,
  dropSignal,
  ourLivePost,
  sellerLine,
} from "../src/web/components/deals/dealSignals.ts";
import type { Deal } from "../src/web/types.ts";

const base = {
  id: "d1",
  sourceId: "amazon",
  externalId: "B0F1R9WVGN",
  title: "Turtle Beach Rematch Core",
  url: "https://www.amazon.fr/dp/B0F1R9WVGN",
  merchantId: "amazon",
  currentPrice: 19.99,
  listPrice: 29.98,
  currency: "EUR",
  discountPercentage: 33,
  availability: "in_stock",
  firstSeenAt: "2026-11-02T09:24:23.756Z",
  lastSeenAt: "2026-11-08T17:12:36.780Z",
  status: "active",
  score: 75,
} as Deal;

describe("dealSignals (epic 30)", () => {
  test("the drop is the score's reference, trusted or not", () => {
    expect(
      dropSignal({
        ...base,
        priceArgument: {
          reference: {
            kind: "lowest30d",
            label: "prix le plus bas des 30 derniers jours",
            price: 28.84,
            trust: 1,
            discountPercentage: 31,
          },
        },
      }),
    ).toMatchObject({ percent: 31, against: "plus bas 30 j", trusted: true });
    // A regular price is trusted even though its weight is below 1.
    expect(
      dropSignal({
        ...base,
        priceArgument: {
          reference: {
            kind: "regular",
            label: "prix habituel",
            price: 24.99,
            trust: 0.9,
            discountPercentage: 70,
          },
        },
      })?.trusted,
    ).toBe(true);
    // Without the argument: the struck price, never trusted alone.
    expect(dropSignal({ ...base, listPriceKind: "rrp" })).toMatchObject({
      percent: 33,
      against: "prix conseillé",
      trusted: false,
    });
    expect(dropSignal({ ...base, currentPrice: 0 })?.free).toBe(true);
  });

  test("page text read as a Cdiscount seller is not shown", () => {
    expect(
      sellerLine({
        ...base,
        merchantId: "cdiscount",
        sellerName: "Passer les filtres rapides",
      }),
    ).toBe("Vendeur non lu");
    expect(sellerLine({ ...base, sellerName: "BRIGHFORTUNE" })).toBe(
      "Vendeur : BRIGHFORTUNE",
    );
    expect(
      sellerLine({ ...base, soldByMerchant: true }, [
        { id: "amazon", name: "Amazon" },
      ]),
    ).toBe("Vendu par Amazon");
  });

  test("Dealabs: ours, someone else's, history, never", () => {
    expect(
      dealabsSignal({
        ...base,
        onDealabs: { url: "", price: 19.99, temperature: 41, mine: true },
      }),
    ).toMatchObject({ label: "Publié par vous · 41°", posted: true });
    expect(
      dealabsSignal({
        ...base,
        onDealabs: {
          url: "",
          price: 19.99,
          temperature: 41,
          mine: true,
          status: "deleted",
        },
      }),
    ).toMatchObject({ label: "Supprimé par Dealabs", posted: false });
    expect(
      dealabsSignal({ ...base, dealabsLowestPrice: 24.99 }).label,
    ).toContain("Posté avant à 24,99");
    expect(dealabsSignal(base).label).toBe("Jamais posté");
  });

  test("our live post is read from the stored Dealabs history", () => {
    const history = JSON.stringify([
      {
        price: 24.99,
        publishedAt: "2026-02-23T18:58:32.000Z",
        temperature: 184,
        isExpired: true,
      },
      {
        price: 19.99,
        publishedAt: "2026-11-02T08:34:51.000Z",
        temperature: 41,
        isExpired: false,
        mine: true,
      },
    ]);
    expect(ourLivePost({ ...base, dealabsHistory: history })?.price).toBe(
      19.99,
    );
    expect(
      ourLivePost({ ...base, dealabsHistory: "not json" }),
    ).toBeUndefined();
  });
});
