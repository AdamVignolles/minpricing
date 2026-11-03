import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import {
  matchesSameWatch,
  parseOcaratListing,
  parseTimeshop24Listing,
  watchCategoryHint,
  watchReference,
} from "../src/api/collectors/watchOffers.ts";
import { CategorizationService } from "../src/api/services/CategorizationService.ts";

const fixture = (name: string) =>
  readFileSync(join(import.meta.dirname, "fixtures/watches", name), "utf8");

describe("parseTimeshop24Listing (saved 2026-11 « Vente de montres » page)", () => {
  const deals = parseTimeshop24Listing(fixture("timeshop24-vente.html"));

  test("reads every card: brand, model, reference; MSRP as a prix conseillé", () => {
    expect(deals).toHaveLength(35);
    expect(deals.filter((deal) => deal.listPrice)).toHaveLength(26);
    expect(deals[0]).toMatchObject({
      externalId: "37382",
      title: "Montre Philipp Plein The Skull 44mm PWAAA0121",
      url: "https://www.timeshop24.fr/philipp-plein-pwaaa0121-the-skull.html",
      price: 198.8,
      listPrice: 390,
      merchantId: "timeshop24",
      categoryHint: "watch:classic",
      details: { soldByMerchant: true, listPriceKind: "rrp" },
    });
  });

  test("a watch without MSRP has no reference price", () => {
    const deal = deals.find((item) => item.externalId === "39045");
    expect(deal?.listPrice).toBeUndefined();
    expect(deal?.details?.listPriceKind).toBeUndefined();
  });

  test("an out-of-stock card is skipped", () => {
    const card = (stock: string) =>
      `<li class="item product product-item"><a class="product-item-link" href="https://www.timeshop24.fr/x.html"><span>Seiko</span><span>5 Sports</span><span>SRPD55K1</span></a><div class="in-stock-icon ${stock}"><div data-product-id="1"><span data-price-amount="199" data-price-type="finalPrice"></span></div></div></li>`;
    expect(parseTimeshop24Listing(card("yes"))).toHaveLength(1);
    expect(parseTimeshop24Listing(card("no"))).toHaveLength(0);
  });
});

describe("parseOcaratListing (saved 2026-11 watch sale page)", () => {
  const deals = parseOcaratListing(fixture("ocarat-black-friday-montre.html"));

  test("watches only, brand moved into the title", () => {
    expect(deals).toHaveLength(40);
    expect(deals.every((deal) => deal.title.startsWith("Montre "))).toBe(true);
    expect(deals[0]).toMatchObject({
      externalId: "64692",
      title: "Montre Thomas Earnshaw Longitude ES-8006-01",
      price: 204,
      listPrice: 240,
      merchantId: "ocarat",
      details: { listPriceKind: "rrp" },
    });
  });

  test("a Garmin is a connected watch (Téléphonie), a Citizen is Mode", () => {
    const categories = new CategorizationService();
    const garmin = deals.find((deal) => /Garmin/.test(deal.title));
    expect(garmin?.categoryHint).toBe("watch:smart");
    expect(categories.fromHint(garmin?.categoryHint)).toBe("phones");
    expect(
      categories.fromHint(watchCategoryHint("Montre Citizen NY4059")),
    ).toBe("fashion");
  });

  test("jewellery on the same page is left out", () => {
    const card = `<article class="ajax_block_product" data-id-product="1"><a class="product-name" href="https://ocarat.com/x.html"><span class="product-brand h5">Emanessence</span><span class="product-title">Bague Tête de Mort</span></a><span class="price product-price"> 26,10 € </span></article>`;
    expect(parseOcaratListing(card)).toHaveLength(0);
  });
});

describe("watch reference cross-search", () => {
  test("the reference is the last code-like word, not a size", () => {
    expect(watchReference("Montre Citizen Mecha Gents NY4059-09AC")).toBe(
      "NY4059-09AC",
    );
    expect(
      watchReference("Montre Garmin Fēnix 8 AMOLED 47 mm 010-02904-21"),
    ).toBe("010-02904-21");
    expect(watchReference("Montre Victorinox Journey 1884 241980.1")).toBe(
      "241980.1",
    );
    expect(
      watchReference("Montre Timberland Ashmont 46mm 5ATM"),
    ).toBeUndefined();
    expect(
      watchReference("Montre Briston Clubmaster Edition Limitée"),
    ).toBeUndefined();
  });

  test("same reference matches, separators ignored; straps don't", () => {
    const ours = "Montre Citizen Mecha Gents NY4059-09AC";
    expect(
      matchesSameWatch(
        ours,
        "NY4059-09AC",
        "Citizen Homme Automatique NY405909AC",
      ).match,
    ).toBe(true);
    expect(
      matchesSameWatch(ours, "NY4059-09AC", "Citizen Mecha NY4058-09AC").match,
    ).toBe(false);
    expect(
      matchesSameWatch(
        ours,
        "NY4059-09AC",
        "Bracelet de rechange compatible Citizen NY4059-09AC",
      ).match,
    ).toBe(false);
  });
});
