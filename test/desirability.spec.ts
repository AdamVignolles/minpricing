import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  type DesirabilityWeights,
  desirabilityTerms,
  findBrand,
} from "../src/api/services/desirability.ts";
import { predictHeat } from "../src/api/services/heatPrediction.ts";

const weights: DesirabilityWeights = {
  brands: {
    Ryobi: 0.5,
    Lenovo: 0.3,
    "Bambu Lab": 0.7,
    Asus: 0,
    PlayStation: 0.2,
  },
  keywords: { "imprimante 3d|3d printer": 0.6, "coque|housse": -0.4 },
  noBrandPenalty: -0.6,
  noBrandCategories: ["computing", "home"],
};

describe("desirabilityTerms", () => {
  it("rewards a loved brand, with its reason", () => {
    expect(
      desirabilityTerms(
        "Meuleuse sans fil Ryobi RAG18125-0 125mm 18V",
        "diy",
        weights,
      ),
    ).toEqual([
      { value: 0.5, reason: "Marque appréciée sur Dealabs (Ryobi)." },
    ]);
  });

  it("matches multi-word brands and product types, accents and case aside", () => {
    const terms = desirabilityTerms(
      "BAMBU LAB A1 mini – Imprimante 3D multicolore",
      "computing",
      weights,
    );
    expect(terms.map((t) => t.value)).toEqual([0.7, 0.6]);
  });

  it("penalises an unknown brand in the listed categories only", () => {
    expect(
      desirabilityTerms(
        "Tablette Android 10 Pouces 14Go RAM",
        "computing",
        weights,
      ),
    ).toEqual([
      { value: -0.6, reason: "Marque inconnue : la communauté s'en méfie." },
    ]);
    expect(
      desirabilityTerms("Short de running Dri-FIT", "sport", weights),
    ).toEqual([]);
  });

  it("treats a known brand at 0 as known, without a term", () => {
    expect(
      desirabilityTerms("Asus TUF Gaming F15", "computing", weights),
    ).toEqual([]);
  });

  it("gives games no brand term (their title names the store)", () => {
    expect(
      desirabilityTerms(
        "Hell Let Loose (PS5, PlayStation Store)",
        "video-games",
        weights,
      ),
    ).toEqual([]);
  });

  it("does not match a brand inside another word", () => {
    expect(findBrand("Asustek-like noname laptop", weights)).toBeUndefined();
  });

  it("moves the heat prediction", () => {
    const base = {
      title: "x",
      categoryId: "diy",
      currentPrice: 76.93,
      realDiscount: 30,
    };
    const plain = predictHeat(base).chance;
    const loved = predictHeat({
      ...base,
      extraTerms: [
        { value: 0.5, reason: "Marque appréciée sur Dealabs (Ryobi)." },
      ],
    });
    expect(loved.chance).toBeGreaterThan(plain);
    expect(loved.reasons).toContain("Marque appréciée sur Dealabs (Ryobi).");
  });
});

describe("config/desirability.json", () => {
  it("is valid and within its own bounds", () => {
    const config = JSON.parse(readFileSync("config/desirability.json", "utf8"));
    const [min, max] = config.bounds;
    for (const value of [
      ...Object.values(config.brands),
      ...Object.values(config.keywords),
    ] as number[]) {
      expect(value).toBeGreaterThanOrEqual(min);
      expect(value).toBeLessThanOrEqual(max);
    }
  });
});
