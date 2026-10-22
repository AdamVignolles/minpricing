import { describe, expect, test } from "vitest";

import {
  type DealabsThread,
  findLiveDuplicate,
  isSameProduct,
  liveOnDealabs,
} from "../src/api/services/dealabsSearch.ts";
import { predictHeat } from "../src/api/services/heatPrediction.ts";

const now = new Date("2026-10-14T12:00:00Z");
const past = (
  daysAgo: number,
  price: number,
  temperature: number,
  isExpired?: boolean,
) => ({
  title: "x",
  price,
  temperature,
  isHot: temperature >= 100,
  isExpired,
  publishedAt: new Date(now.getTime() - daysAgo * 86_400_000).toISOString(),
  url: "https://www.dealabs.com/bons-plans/x-1",
});
const laptop = {
  title: "PC Portable Lenovo IdeaPad Slim 3",
  categoryId: "computing",
  currentPrice: 369.99,
  realDiscount: 43,
  soldByMerchant: true,
};

describe("predictHeat", () => {
  test("a product already hot, at a record price, is promising", () => {
    const base = predictHeat(laptop, now);
    const hot = predictHeat(
      {
        ...laptop,
        currentPrice: 349.99,
        history: [past(40, 369.99, 925, true)],
      },
      now,
    );
    expect(hot.chance).toBeGreaterThan(base.chance);
    expect(hot.reasons.join(" ")).toMatch(/très chaud/);
    expect(hot.reasons.join(" ")).toMatch(/Nouveau record/);
  });

  test("a still-live deal at the same price makes ours a repost", () => {
    const expired = predictHeat(
      { ...laptop, history: [past(2, 359.99, 925, true)] },
      now,
    );
    const live = predictHeat(
      { ...laptop, history: [past(2, 359.99, 925, false)] },
      now,
    );
    expect(live.chance).toBeLessThan(expired.chance);
    expect(live.reasons[0]).toMatch(/doublon/);
    expect(expired.reasons.join(" ")).not.toMatch(/doublon/);
  });

  test("already posted much cheaper: 'déjà vu moins cher'", () => {
    const result = predictHeat(
      {
        ...laptop,
        categoryId: "home",
        currentPrice: 175.99,
        history: [past(60, 89.71, 778, true)],
      },
      now,
    );
    expect(result.reasons.join(" ")).toMatch(/Déjà posté moins cher/);
  });

  test("free beats paid; a marketplace seller costs points", () => {
    const game = {
      title: "Jeu",
      categoryId: "video-games",
      currentPrice: 9.99,
      realDiscount: 60,
    };
    expect(
      predictHeat({ ...game, currentPrice: 0 }, now).chance,
    ).toBeGreaterThan(predictHeat(game, now).chance);
    const thirdParty = predictHeat(
      { ...laptop, soldByMerchant: false, sellerName: "JIAGAHAI" },
      now,
    );
    expect(thirdParty.chance).toBeLessThan(predictHeat(laptop, now).chance);
    expect(thirdParty.reasons[0]).toMatch(/Vendeur tiers/);
  });

  test("chance is a percentage and the label follows it", () => {
    const result = predictHeat(laptop, now);
    expect(result.chance).toBeGreaterThanOrEqual(0);
    expect(result.chance).toBeLessThanOrEqual(100);
    expect(["froid", "tiède", "prometteur", "chaud"]).toContain(result.label);
  });
});

describe("isSameProduct — false matches seen in real history", () => {
  test("a bundle listing the game isn't the game's history", () => {
    expect(
      isSameProduct("Core Keeper", 11.99, {
        title:
          "Humble Choice Février 2026 - Resident Evil Village, Date Everything!, Core Keeper, StarVaders",
        price: 12.99,
      }),
    ).toBe(false);
  });

  test("a short name needs its model code", () => {
    expect(
      isSameProduct("Asus TUF GAMING - TR120 Fan ARGB REVERSE - Blanc", 17.99, {
        title: "Boîtier externe SSD Asus Tuf Gaming A1 USB-C 3.2 Gen 2",
        price: 31.99,
      }),
    ).toBe(false);
  });

  test("kids sizes and an Indoor variant aren't the same sneaker", () => {
    expect(
      isSameProduct("adidas Gazelle - Bebes Chaussures", 30, {
        title: "Baskets adidas Gazelle Indoor Orange - Du 35.5 au 37 1/3",
        price: 33.15,
      }),
    ).toBe(false);
    expect(
      isSameProduct("adidas Gazelle - Bebes Chaussures", 30, {
        title: "Baskets adidas Gazelle bébé - du 19 au 27",
        price: 29.99,
      }),
    ).toBe(true);
  });
});

describe("findLiveDuplicate", () => {
  const thread = (over: Partial<DealabsThread>): DealabsThread => ({
    id: "1",
    title: "Caméra Blink Outdoor 4 - HD, sans fil",
    price: 24.99,
    temperature: 3112,
    isHot: true,
    isExpired: false,
    publishedAt: new Date(now.getTime() - 10 * 86_400_000).toISOString(),
    url: "https://www.dealabs.com/bons-plans/blink-1",
    ...over,
  });
  const ours = "Caméra Blink Outdoor 4 : caméra de surveillance connectée HD";

  test("same product, live, same price: duplicate", () => {
    expect(findLiveDuplicate([thread({})], ours, 24.99, now)?.url).toBe(
      "https://www.dealabs.com/bons-plans/blink-1",
    );
  });

  test("expired, older than 30 days, or pricier: not a duplicate", () => {
    expect(
      findLiveDuplicate([thread({ isExpired: true })], ours, 24.99, now),
    ).toBe(undefined);
    expect(
      findLiveDuplicate(
        [
          thread({
            publishedAt: new Date(
              now.getTime() - 45 * 86_400_000,
            ).toISOString(),
          }),
        ],
        ours,
        24.99,
        now,
      ),
    ).toBe(undefined);
    expect(
      findLiveDuplicate([thread({ price: 34.99 })], ours, 24.99, now),
    ).toBe(undefined);
  });
});

describe("liveOnDealabs (greyed deal cards)", () => {
  const past = (over: Record<string, unknown>) => ({
    url: "https://www.dealabs.com/bons-plans/x-1",
    price: 49.99,
    temperature: 399.4,
    publishedAt: new Date(now.getTime() - 10 * 86_400_000).toISOString(),
    isExpired: false,
    ...over,
  });

  test("a live deal at our price or cheaper", () => {
    expect(liveOnDealabs([past({})], 49.99, now)).toEqual({
      url: "https://www.dealabs.com/bons-plans/x-1",
      price: 49.99,
      temperature: 399,
      mine: false,
    });
  });

  test("our own live post greys the card as ours", () => {
    expect(liveOnDealabs([past({ mine: true })], 49.99, now)?.mine).toBe(true);
  });

  test("our own posts never count in the prediction", () => {
    const base = {
      title: "Echo Spot",
      categoryId: "audio",
      currentPrice: 49.99,
      realDiscount: 50,
    };
    const withOwn = predictHeat(
      {
        ...base,
        history: [
          {
            ...past({ mine: true, temperature: 3000 }),
            title: "x",
            isHot: true,
          },
        ],
      },
      now,
    );
    expect(withOwn.chance).toBe(predictHeat(base, now).chance);
  });

  test("expired or too old: not on Dealabs; pricier still is", () => {
    expect(liveOnDealabs([past({ isExpired: true })], 49.99, now)).toBe(
      undefined,
    );
    // A pricier live deal still means "already on Dealabs".
    expect(liveOnDealabs([past({ price: 59.99 })], 49.99, now)?.price).toBe(
      59.99,
    );
    expect(
      liveOnDealabs(
        [
          past({
            publishedAt: new Date(
              now.getTime() - 40 * 86_400_000,
            ).toISOString(),
          }),
        ],
        49.99,
        now,
      ),
    ).toBe(undefined);
  });

  test("history without the expiry flag counts only when recent", () => {
    expect(liveOnDealabs([past({ isExpired: undefined })], 49.99, now)).toBe(
      undefined,
    );
    expect(
      liveOnDealabs(
        [
          past({
            isExpired: undefined,
            publishedAt: new Date(now.getTime() - 3 * 86_400_000).toISOString(),
          }),
        ],
        49.99,
        now,
      )?.temperature,
    ).toBe(399);
  });
});

describe("isSameProduct — multi-platform threads", () => {
  test("a thread listing several platforms matches ours", () => {
    expect(
      isSameProduct("Invincible VS (Xbox Series, Xbox Store)", 29.99, {
        title: "Invincible VS sur PS5 et Xbox Series X",
        price: 24.99,
      }),
    ).toBe(true);
    expect(
      isSameProduct(
        "Yakuza 0 Director's Cut PS5 (PS5, PlayStation Store)",
        24.99,
        {
          title: "Yakuza 0 Director's Cut sur PS5, PC ou Switch 2",
          price: 18.95,
        },
      ),
    ).toBe(true);
  });

  test("another platform only is still another product", () => {
    expect(
      isSameProduct("Hell is Us (PS5, PlayStation Store)", 11.99, {
        title: "Hell is Us sur PC (Dématérialisé - Steam)",
        price: 14.99,
      }),
    ).toBe(false);
    expect(
      isSameProduct("Mortal Kombat 11 (PS4/PS5, PlayStation Store)", 4.99, {
        title: "Mortal Kombat 11 sur PC (Dématérialisé - Steam)",
        price: 4.99,
      }),
    ).toBe(false);
  });
});
