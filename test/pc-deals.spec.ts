import { describe, expect, test } from "vitest";

import {
  lenovoModelFromUrl,
  lenovoModelName,
  lenovoNameSpecs,
  parseLenovoProducts,
} from "../src/api/collectors/retailOffers.ts";
import {
  isComputer,
  isKnownPcBrand,
  parsePcSpecs,
  pcWarnings,
} from "../src/api/services/pcSpecs.ts";
import { qualityIssue } from "../src/api/services/qualityGate.ts";

describe("computers: known brands only", () => {
  test("no-name laptops we posted (all went cold) are rejected", () => {
    for (const title of [
      'PC Portable 14" Bvate - N4020, 8 Go RAM DDR4, Win 11, 256 Go SSD',
      'PC Portable 14" Ruzava - Ryzen 5 3500U, 16 Go Ram, 512 Go SSD',
      "Modern Laptop 15 pouces Intel Core i5 16 Go RAM 512 Go SSD",
    ]) {
      expect(qualityIssue({ title, sourceId: "amazon" })).toBeDefined();
    }
  });

  test("known makers pass", () => {
    for (const title of [
      'PC Portable 15,8" Lenovo IdeaPad Slim 3 - Ryzen 3, 8 Go RAM, 512 Go SSD',
      'PC Portable - SAMSUNG - Galaxy Book5 Pro - 14" - Core Ultra 5 - 16 Go - 512 Go SSD',
      "Mini PC GMKtec AMD Ryzen 5 3500U 16 Go RAM 512 Go SSD",
    ]) {
      expect(isComputer(title)).toBe(true);
      expect(isKnownPcBrand(title)).toBe(true);
      expect(qualityIssue({ title, sourceId: "cdiscount" })).toBe(undefined);
    }
  });

  test("accessories for a PC aren't computers", () => {
    expect(
      isComputer("Sacoche pour ordinateur portable 16 pouces Trust Bologna"),
    ).toBe(false);
    expect(
      qualityIssue({
        title: "Support PC portable aluminium réglable",
        sourceId: "amazon",
      }),
    ).toBe(undefined);
  });
});

describe("parsePcSpecs / pcWarnings", () => {
  test("reads RAM, storage and CPU from a title", () => {
    expect(
      parsePcSpecs(
        "PC portable Lenovo Legion 5 15IRX10 - Core i7-14650HX - 32 Go RAM - 1 To SSD",
      ),
    ).toMatchObject({ ramGb: 32, storageGb: 1000 });
    expect(
      parsePcSpecs("Mémoire : 16 Go LPDDR5x\nStockage : 512 Go SSD M.2"),
    ).toMatchObject({ ramGb: 16, storageGb: 512 });
  });

  test("calls out a weak config for the price", () => {
    expect(pcWarnings({ ramGb: 8, storageGb: 512 }, 749)).toHaveLength(1);
    expect(pcWarnings({ ramGb: 8, storageGb: 256 }, 799)).toHaveLength(2);
    expect(pcWarnings({ ramGb: 16, storageGb: 512 }, 749)).toEqual([]);
    expect(pcWarnings({ ramGb: 8, storageGb: 256 }, 399)).toEqual([]);
  });
});

describe("Lenovo store", () => {
  test("model name and deal from the API", () => {
    expect(
      lenovoModelName(
        "IdeaPad Slim 3 16IWC11_83RS - IdeaPad Slim 3 16IWC11_01_FR",
      ),
    ).toBe("IdeaPad Slim 3 16IWC11");
    expect(
      lenovoModelFromUrl(
        "/p/laptops/yoga/yoga-slim-series/yoga-slim-7-gen-9-15-inch-intel/83cl",
      ),
    ).toBe("Yoga Slim 7 Gen 9 15 Intel");
    const [deal] = parseLenovoProducts({
      data: {
        data: [
          {
            productCode: "21V0CTO1WWFR1",
            productName: "ThinkBook 14x ILL_22BG - ThinkBook 14x ILL_03_FR",
            finalPrice: "1003.50",
            webPrice: "1368.91",
            couponCode: "OCTOBRE",
            ratingStar: "4.9",
            commentCount: 16,
            url: "/p/laptops/thinkbook/21v0cto1wwfr1",
            classification: [
              { a: "Processeur", b: "Intel® Core™ Ultra 5 225H" },
              { a: "Mémoire", b: "16 Go LPDDR5x" },
            ],
          },
        ],
      },
    });
    expect(deal).toMatchObject({
      title:
        "PC portable Lenovo ThinkBook 14x ILL - Core Ultra 5 225H, 16 Go RAM",
      price: 1003.5,
      listPrice: 1368.91,
      url: "https://www.lenovo.com/fr/fr/p/laptops/thinkbook/21v0cto1wwfr1",
    });
    expect(deal.description).toContain("- Mémoire : 16 Go LPDDR5x");
    expect(deal.description).toContain("code OCTOBRE");
  });
});

describe("Lenovo pre-configured names", () => {
  test("specs decoded from the name", () => {
    expect(lenovoNameSpecs("NB IPS3 15IRU10 CORE3 8G 8G 256G 11H")).toEqual([
      "- Processeur : Core 3",
      "- Mémoire : 8 Go RAM",
      "- Stockage : 256 Go SSD",
    ]);
    expect(lenovoNameSpecs("NB LGNP5 16ADR10 R9 32G 1T 11H")).toEqual([
      "- Processeur : Ryzen 9",
      "- Mémoire : 32 Go RAM",
      "- Stockage : 1000 Go SSD",
    ]);
  });
});

describe("lessons from our October posts", () => {
  test("Athlon laptops and 128 Go storage are rejected", () => {
    expect(
      qualityIssue({
        title:
          "PC Portable 15'' LENOVO IdeaPad Slim 3 15AMN8 - Athlon Gold 7220U - 8 Go - 128 Go SSD",
        sourceId: "cdiscount",
      }),
    ).toMatch(/entrée de gamme/);
    expect(
      qualityIssue({
        title: "PC Portable HP 15 - Intel Core i3 - 8 Go RAM - 128 Go SSD",
        sourceId: "amazon",
      }),
    ).toMatch(/128 Go/);
  });

  test("16 Go on a 1 000 € laptop is called out", () => {
    expect(pcWarnings({ ramGb: 16, storageGb: 1000 }, 1003.5)[0]).toMatch(
      /32 Go/,
    );
    expect(pcWarnings({ ramGb: 32, storageGb: 1000 }, 1003.5)).toEqual([]);
  });

  test("console-store shovelware under 3 € is rejected", () => {
    expect(
      qualityIssue({
        title: "AAA Games Ultimate Collection (Nintendo Switch, eShop)",
        sourceId: "nintendo",
        price: 1.99,
        listPrice: 99.99,
      }),
    ).toMatch(/moins de 3 €/);
    expect(
      qualityIssue({
        title: "Mortal Kombat 11 (PS4/PS5, PlayStation Store)",
        sourceId: "playstation",
        price: 4.99,
        listPrice: 49.99,
      }),
    ).toBe(undefined);
  });
});
