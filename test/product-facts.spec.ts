import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { parseAmazonFacts } from "../src/api/collectors/amazonProductHtml.ts";
import { compactFacts, tidySpecs } from "../src/api/collectors/productFacts.ts";
import { buildDealFacts } from "../src/api/services/dealFacts.ts";

const fixture = (...path: string[]) =>
  readFileSync(join(import.meta.dirname, "fixtures", ...path), "utf8");

describe("tidySpecs", () => {
  test("keeps buyer facts, pulls brand/model/reference/warranty out, drops noise", () => {
    const out = tidySpecs([
      { label: "Marque", value: "Crucial" },
      { label: "Nom du modèle", value: "DDR5 Pro Overclocking RAM" },
      { label: "Numéro du modèle de l'article", value: "CP2K16G60C36U5B" },
      { label: "Garantie fabricant", value: "5 ans" },
      { label: " appareils compatibles ", value: " Ordinateur " },
      { label: "ASIN", value: "B0CTHXMYL8" },
      {
        label: "Classement des meilleures ventes d'Amazon",
        value: "12 en Informatique",
      },
      { label: "Nombre d’emballages", value: "2" },
      { label: "Appareils compatibles", value: "doublon" },
      { label: "Tension", value: "" },
    ]);
    expect(out).toEqual({
      specs: [{ label: "Appareils compatibles", value: "Ordinateur" }],
      brand: "Crucial",
      model: "DDR5 Pro Overclocking RAM",
      reference: "CP2K16G60C36U5B",
      warranty: "Garantie fabricant : 5 ans",
    });
  });

  test("caps the list", () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({
      label: `L${i}`,
      value: `${i}`,
    }));
    expect(tidySpecs(rows, 5).specs).toHaveLength(5);
  });

  test("compactFacts drops empty values and returns undefined when nothing is left", () => {
    expect(
      compactFacts({ specs: [], stock: "", coupon: undefined }),
    ).toBeUndefined();
    expect(compactFacts({ stock: "En stock", specs: [] })).toEqual({
      stock: "En stock",
    });
  });
});

describe("parseAmazonFacts", () => {
  // Extract of the live page of B0CTHXMYL8 (Crucial Pro DDR5 32 Go),
  // 2026-11-05: title, key attributes, stock, sold/shipped by, returns,
  // technical table.
  const html = fixture("amazon", "B0CTHXMYL8-facts.html");

  test("spec table, brand, model, stock and return window from a real page", () => {
    const facts = parseAmazonFacts(html);
    expect(facts?.brand).toBe("Crucial");
    expect(facts?.model).toBe("DDR5 Pro Overclocking RAM");
    expect(facts?.stock).toBe("En stock");
    expect(facts?.returns).toBe("Retournable jusqu’au 15 janvier 2027");
    const specs = facts?.specs ?? [];
    expect(specs.length).toBeGreaterThanOrEqual(6);
    expect(specs.length).toBeLessThanOrEqual(12);
    expect(specs).toEqual(
      expect.arrayContaining([
        { label: "Technologie de mémoire RAM", value: "DDR5" },
        { label: "Vitesse de mémoire", value: "6000 MHz" },
      ]),
    );
    // Catalogue noise never reaches the description.
    expect(specs.map((s) => s.label).join(" ")).not.toMatch(
      /ASIN|UPC|Classement|emballages|Unité de comptage|Marque/,
    );
    // Nothing location-dependent from this sandbox (« États-Unis »).
    expect(facts?.delivery).toBeUndefined();
  });

  test("coupon and free delivery when the page says so", () => {
    const facts = parseAmazonFacts(
      `<div id="productTitle">X</div>
       <div id="couponsInBuybox_feature_div"><label>Appliquer le coupon de 10 %</label></div>
       <div id="deliveryBlockMessage">Livraison GRATUITE mardi 10 novembre</div>`,
    );
    expect(facts).toEqual({ coupon: "10 %", delivery: "Livraison gratuite" });
    expect(
      parseAmazonFacts(
        `<div id="productTitle">X</div><div id="vpcButton">Économisez 15,00 € avec coupon</div>`,
      )?.coupon,
    ).toBe("15,00 €");
  });

  test("a robot check gives no facts", () => {
    expect(
      parseAmazonFacts(
        `<form action="/errors/validateCaptcha">Saisissez les caractères</form>`,
      ),
    ).toBeUndefined();
  });

  test("the facts reach DealFacts with their provenance", () => {
    const stored = parseAmazonFacts(html);
    const facts = buildDealFacts({
      sourceId: "amazon",
      title: "Crucial Pro RAM DDR5 32Go Kit (2x16Go) 6000MHz CL36",
      url: "https://www.amazon.fr/dp/B0CTHXMYL8",
      currentPrice: 499.99,
      description: "- Compatible : Intel et AMD",
      extraFacts: JSON.stringify(stored),
      detailsCheckedAt: "2026-11-05T08:00:00.000Z",
    });
    expect(facts.product.brand).toEqual({
      value: "Crucial",
      from: {
        via: "merchant",
        fields: ["extraFacts"],
        asOf: "2026-11-05T08:00:00.000Z",
      },
    });
    expect(facts.offer?.returns?.value).toMatch(/15 janvier 2027/);
    expect(facts.offer?.stockText?.value).toBe("En stock");
    // The page table first, then what only the merchant text says.
    expect(facts.specs?.value.at(-1)).toEqual({
      label: "Compatible",
      value: "Intel et AMD",
    });
    expect(facts.specs?.from.fields).toEqual(["extraFacts", "description"]);
  });

  test("unreadable stored facts are no facts", () => {
    const facts = buildDealFacts({
      sourceId: "amazon",
      title: "x",
      url: "u",
      currentPrice: 1,
      extraFacts: "{not json",
    });
    expect(facts.offer).toBeUndefined();
    expect(facts.product.brand).toBeUndefined();
  });
});

describe("parseGogProduct", () => {
  // api.gog.com/v2/games/1207658930?locale=fr-FR (The Witcher 2), trimmed.
  const json = JSON.parse(fixture("gog", "product-1207658930.json"));

  test("first paragraph, systems, features, genre, developer, French", async () => {
    const { parseGogProduct } =
      await import("../src/api/collectors/storeOffers.ts");
    const { description, facts } = parseGogProduct(json);
    expect(description).toMatch(/^Deuxième opus de la série/);
    expect(description!.length).toBeLessThanOrEqual(500);
    expect(facts?.platforms).toEqual(expect.arrayContaining(["Windows"]));
    expect(facts?.features).toEqual(
      expect.arrayContaining(["Sauvegardes sur le Cloud", "Solo"]),
    );
    expect(facts?.languages).toEqual([
      "Textes en français",
      "Voix en français",
    ]);
    expect(facts?.specs).toEqual(
      expect.arrayContaining([
        { label: "Développeur", value: "CD PROJEKT RED" },
        expect.objectContaining({ label: "Genre" }),
      ]),
    );
  });

  test("an empty answer gives nothing", async () => {
    const { parseGogProduct } =
      await import("../src/api/collectors/storeOffers.ts");
    expect(parseGogProduct({})).toEqual({
      description: undefined,
      facts: undefined,
    });
  });
});

describe("watch shop product pages", () => {
  test("Ocarat: movement, diameter, water resistance, glass, warranty", async () => {
    const { parseOcaratProduct } =
      await import("../src/api/collectors/watchOffers.ts");
    const facts = parseOcaratProduct(
      fixture("watches", "ocarat-product-80131-3NM-NIB.html"),
    );
    const specs = Object.fromEntries(
      (facts?.specs ?? []).map((s) => [s.label, s.value]),
    );
    expect(specs).toMatchObject({
      Mouvement: "Automatique (masse oscillante)",
      Diamètre: "38 mm",
      Étanchéité: "30 ATM",
      Verre: "Verre saphir",
      Fabrication: "Suisse",
    });
    expect(facts?.specs?.[0].label).toBe("Mouvement");
    expect(facts?.warranty).toBe("Garantie 2 ans (internationale)");
    expect(facts?.delivery).toBe("Livraison gratuite");
  });

  test("Timeshop24: overview list and spec table", async () => {
    const { parseTimeshop24Product } =
      await import("../src/api/collectors/watchOffers.ts");
    const facts = parseTimeshop24Product(
      fixture("watches", "timeshop24-product-11429-769.html"),
    );
    const specs = Object.fromEntries(
      (facts?.specs ?? []).map((s) => [s.label, s.value]),
    );
    expect(specs).toMatchObject({
      Mouvement: "Quartz",
      Diamètre: "29 mm",
      Étanchéité: "5 ATM",
    });
    expect(facts?.delivery).toBe("Livraison gratuite");
  });
});

describe("Screwfix product page", () => {
  test("spec table, warranty, and « Click & Collect » only", async () => {
    const { parseScrewfixProduct } =
      await import("../src/api/collectors/retailOffers.ts");
    const facts = parseScrewfixProduct(
      fixture("screwfix", "product-496JJ.html"),
    );
    expect(facts?.storePickupOnly).toBe(true);
    expect(facts?.warranty).toMatch(/2 ans/);
    expect(facts?.model).toBe("Halogen Prolite");
    expect(facts?.specs).toEqual(
      expect.arrayContaining([
        { label: "Matériau principal des chaussures", value: "Cuir" },
      ]),
    );
    expect((facts?.specs ?? []).length).toBeLessThanOrEqual(10);
  });

  test("home delivery available: not pickup-only", async () => {
    const { parseScrewfixProduct } =
      await import("../src/api/collectors/retailOffers.ts");
    expect(
      parseScrewfixProduct(
        `<div id="stock-state" data-only-hd="0" data-only-cc="0"></div>`,
      ),
    ).toBeUndefined();
  });

  test("pickup-only becomes a DealFacts warning", () => {
    const facts = buildDealFacts({
      sourceId: "screwfix",
      title:
        "Chaussures de sécurité SB P DEWALT Halogen Prolite marron pointure 43",
      url: "u",
      currentPrice: 54.99,
      extraFacts: JSON.stringify({ storePickupOnly: true }),
    });
    expect(facts.offer?.storePickupOnly?.value).toBe(true);
    expect(facts.warnings.map((w) => w.value)).toContain("store-pickup-only");
  });
});

describe("readFactsOnce", () => {
  test("only products without facts, capped, failures skipped, never throws", async () => {
    const { readFactsOnce } =
      await import("../src/api/collectors/productFacts.ts");
    const deal = (id: string) => ({
      externalId: id,
      title: id,
      url: `https://shop/${id}`,
      price: 1,
      currency: "EUR",
      details: { sellerName: "Shop" },
    });
    const deals = [deal("a"), deal("b"), deal("c"), deal("d")];
    const read: string[] = [];
    await readFactsOnce(deals, {
      context: { needsDetails: () => false, needsFacts: (id) => id !== "b" },
      max: 2,
      step: "x",
      sleep: async () => {},
      read: async (d) => {
        read.push(d.externalId);
        if (d.externalId === "a") throw new Error("down");
        return { stock: "En stock" };
      },
    });
    expect(read).toEqual(["a", "c"]);
    expect(deals[0].details).toEqual({ sellerName: "Shop" });
    expect(deals[2].details).toEqual({
      sellerName: "Shop",
      facts: { stock: "En stock" },
    });
  });
});

describe("Steam store facts", () => {
  test("systems, features, French texts, genre, developer, review label", async () => {
    const { steamStoreFactsToStored } =
      await import("../src/api/collectors/SteamCollector.ts");
    // Real appdetails answer for House Flipper (613100), 2026-11-05.
    const data = JSON.parse(fixture("steam", "appdetails-613100.json"))[
      "613100"
    ].data;
    const facts = steamStoreFactsToStored(
      {
        summary: data.short_description,
        genres: data.genres.map((g: { description: string }) => g.description),
        developers: data.developers,
        publishers: data.publishers,
        releaseDate: data.release_date?.date,
        metacritic: data.metacritic?.score,
        platforms: data.platforms,
        supportedLanguages: data.supported_languages,
        categories: data.categories.map(
          (c: { description: string }) => c.description,
        ),
      },
      // The review label comes from appreviews' query_summary (synthetic here:
      // that endpoint redirects the cloud sandbox).
      { productRating: 4.7, productReviewCount: 2254, label: "Très positives" },
    );
    expect(facts?.platforms).toEqual(["Windows", "macOS"]);
    expect(facts?.languages).toEqual(["Textes en français"]);
    expect(facts?.features).toEqual(
      expect.arrayContaining([
        "Solo",
        "Succès Steam",
        "Steam Cloud",
        "Compat. contrôleurs complète",
      ]),
    );
    expect(facts?.features).not.toContain("Cartes à échanger Steam");
    expect(facts?.specs).toEqual(
      expect.arrayContaining([
        { label: "Avis Steam", value: "Très positives (94 % sur 2 254 avis)" },
        expect.objectContaining({ label: "Genre" }),
        expect.objectContaining({ label: "Développeur" }),
      ]),
    );
  });

  test("French voices from « Français<strong>*</strong> »", async () => {
    const { steamStoreFactsToStored } =
      await import("../src/api/collectors/SteamCollector.ts");
    const facts = steamStoreFactsToStored(
      {
        genres: [],
        developers: [],
        publishers: [],
        supportedLanguages:
          "Anglais<strong>*</strong>, Français<strong>*</strong><br><strong>*</strong>langues avec support audio complet",
      },
      {},
    );
    expect(facts?.languages).toEqual([
      "Textes en français",
      "Voix en français",
    ]);
  });
});
