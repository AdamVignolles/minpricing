import { describe, expect, test } from "vitest";

import {
  giveawayGameName,
  selectGiveaways,
  type GamerPowerGiveaway,
} from "../src/api/collectors/storeOffers.ts";
import { parseSoshPlans } from "../src/api/collectors/telecomOffers.ts";
import {
  comparablePlans,
  planDataGb,
  type PlanLike,
} from "../src/api/services/telecomMarket.ts";

const plan = (
  sourceId: string,
  title: string,
  price: number,
  description = "",
): PlanLike => ({
  id: `${sourceId}-${title}`,
  sourceId,
  title,
  description,
  currentPrice: price,
  url: `https://${sourceId}.example/`,
});

describe("planDataGb", () => {
  test("volume from the title, then the description", () => {
    expect(planDataGb(plan("sfr", "Forfait mobile RED 250Go 5G", 15.99))).toBe(
      250,
    );
    expect(
      planDataGb(plan("free", "Forfait mobile Série Free", 12.99, "160Go NAT")),
    ).toBe(160);
  });

  test("unlimited data, but not unlimited calls", () => {
    expect(
      planDataGb(
        plan("free", "Forfait mobile Free 5G+", 19.99, "Forfait Free illimité"),
      ),
    ).toBe(10_000);
    expect(
      planDataGb(
        plan(
          "sfr",
          "Forfait mobile RED 40Go",
          9.99,
          "Appels, SMS et MMS illimités",
        ),
      ),
    ).toBe(40);
  });

  test("boxes aren't compared", () => {
    expect(
      planDataGb(plan("orange", "Orange Offre internet Fibre", 29.99)),
    ).toBe(undefined);
  });
});

describe("comparablePlans", () => {
  const plans = [
    plan("sfr", "Forfait mobile RED 40Go", 9.99),
    plan("free", "Forfait mobile Série Free", 12.99, "160Go"),
    plan("bouygues", "Forfait mobile B&YOU 20Go 5G", 9.99),
    plan("bouygues", "Forfait mobile B&YOU 20Go 4G", 8.99),
  ];

  test("only other operators, at least as much data, cheapest first", () => {
    const found = comparablePlans(plans[0], plans);
    expect(found.map((c) => c.price)).toEqual([12.99]);
    // B&YOU 20Go 4G isn't compared with B&YOU's own 5G variant.
    const byou = comparablePlans(plans[3], plans);
    expect(byou.map((c) => c.title)).toEqual([
      "Forfait mobile RED 40Go",
      "Forfait mobile Série Free",
    ]);
  });
});

describe("parseSoshPlans", () => {
  test("one plan per block", () => {
    const text = `Forfaits mobile sans engagement
Forfait Voyage 200Go 5G
15,99€ par mois

15,99 € /mois

200Go depuis la France
Appels et SMS/MMS illimités
Sélectionner
Voir le détail
Forfait 20Go
9,99€ par mois
20Go depuis la France
Voir le détail`;
    const offers = parseSoshPlans(text);
    expect(offers.map((o) => [o.name, o.price])).toEqual([
      ["Forfait Sosh Voyage 200Go 5G", 15.99],
      ["Forfait Sosh 20Go", 9.99],
    ]);
    expect(offers[0].description).toContain("- 200Go depuis la France");
    expect(offers[0].description).not.toContain("€ /mois");
  });
});

describe("selectGiveaways", () => {
  const g = (
    title: string,
    platforms: string,
    worth: string,
    type = "Game",
  ): GamerPowerGiveaway => ({
    id: title.length,
    title,
    platforms,
    worth,
    type,
    open_giveaway_url: "https://www.gamerpower.com/open/x",
  });

  test("real stores and real value only", () => {
    const kept = selectGiveaways([
      g("Control (Steam) Giveaway", "PC, Steam", "$29.99"),
      g("The Big Con (Mobile) Giveaway", "Android, iOS", "$5.99"),
      g("TerraScape (Epic Games) Giveaway", "PC, Epic Games Store", "$14.99"),
      g("Best Plumber (IndieGala) Giveaway", "PC, DRM-Free", "$29.99"),
      g("Dwarven Realms (Steam) Key Giveaway", "PC, Steam", "$9.99"),
      g("Cheap (Steam) Giveaway", "PC, Steam", "$2.99"),
      g("Skin pack (Steam) Giveaway", "PC, Steam", "$19.99", "DLC"),
    ]).map((x) => x.title);
    expect(kept).toEqual([
      "Control (Steam) Giveaway",
      "The Big Con (Mobile) Giveaway",
    ]);
  });

  test("game name without the store and 'Giveaway'", () => {
    expect(giveawayGameName("TerraScape (Epic Games) Giveaway")).toBe(
      "TerraScape",
    );
    expect(giveawayGameName("Dwarven Realms (Steam) Key Giveaway")).toBe(
      "Dwarven Realms",
    );
  });
});
