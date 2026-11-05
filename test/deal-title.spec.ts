import { describe, expect, test } from "vitest";

import {
  buildDealFacts,
  type DealFactsInput,
} from "../src/api/services/dealFacts.ts";
import { buildDealTitle, dealabsTitle } from "../src/api/services/dealTitle.ts";

const title = (
  deal: Partial<DealFactsInput> & { title: string },
  merchantName?: string,
) =>
  buildDealTitle(
    buildDealFacts(
      {
        sourceId: "amazon",
        url: "https://example.test/p",
        currentPrice: 10,
        ...deal,
      },
      { merchantName },
    ),
  );

// Pairs from the audit (folio F17 §3): our title → moderators' title.
describe("product titles (real moderator rewrites)", () => {
  test("Crucial: implied type added, « 32 Go », trailing SKU dropped", () => {
    expect(
      title({
        title:
          "Crucial Pro RAM DDR5 32Go Kit (2x16Go) 6000MHz CL36, Overclocking Gaming, Intel XMP 3.0 / AMD Expo, PC Mémoire, Noir - CP2K16G60C36U5B",
      }),
    ).toBe(
      "Mémoire RAM Crucial Pro RAM DDR5 32 Go Kit (2x16 Go) 6000MHz CL36, Overclocking Gaming, Intel XMP 3.0 / AMD Expo, PC Mémoire, Noir",
    );
  });

  test("MSI: the type moves to the front", () => {
    expect(
      title({
        title:
          "MSI MAG A850GLS PCIE5 Alimentation modulaire ATX 3.1, 80 PLUS Gold",
      }),
    ).toBe(
      "Alimentation modulaire MSI MAG A850GLS PCIE5 ATX 3.1, 80 PLUS Gold",
    );
  });

  test("Cecotec coffee machine: type first, « . » becomes « - »", () => {
    expect(
      title({
        title:
          "Cecotec Machine a Café Expresso Power Espresso 20 Cream. Cafetière 20 Bars, Réservoir À Lait 700 Ml",
      }),
    ).toBe(
      "Machine a Café Expresso Cecotec Power Espresso 20 Cream - Cafetière 20 Bars, Réservoir À Lait 700 Ml",
    );
  });

  test("Cecotec microwave: no marketing word, « | » becomes « - »", () => {
    expect(
      title({
        title:
          "Cecotec Micro-ondes Professionnel Capacité 23L Proclean 5130 Gril 1000W | 800W Micro-ondes + 1000W Gril",
      }),
    ).toBe(
      "Micro-ondes Cecotec Capacité 23L Proclean 5130 Gril 1000W - 800W Micro-ondes + 1000W Gril",
    );
  });

  test("TV already starts with its type: kept", () => {
    expect(title({ title: "TV QLED 4K 75'' (189 cm) 75Q6FA SAMSUNG" })).toBe(
      "TV QLED 4K 75'' (189 cm) 75Q6FA SAMSUNG",
    );
  });

  test("Turtle Beach: type from mid-title, marketplace suffix", () => {
    expect(
      title({
        title:
          "Turtle Beach Rematch Core, manette filaire homologuée pour XBOX et PC | Ghost Black Camo jaune",
        soldByMerchant: false,
        sellerName: "GameShop",
      }),
    ).toBe(
      "Manette filaire Turtle Beach Rematch Core, homologuée pour XBOX et PC - Ghost Black Camo jaune (Vendeur tiers)",
    );
  });

  test("an accessory « pour tablette » is not a tablet", () => {
    expect(
      title({ title: "Housse ProCase pour tablette Galaxy Tab A9+" }),
    ).toBe("Housse ProCase pour tablette Galaxy Tab A9+");
  });

  test("watches keep their reference", () => {
    expect(
      title({
        sourceId: "ocarat",
        title: "Montre Edox Skydiver 38 Date Automatic - 80131-3NM-NIB",
      }),
    ).toBe("Montre Edox Skydiver 38 Date Automatic - 80131-3NM-NIB");
  });

  test("refurbished: prefix and state", () => {
    expect(
      title({
        sourceId: "itjustgood",
        title:
          'PC Portable 14" Dell Latitude 3410 - Core i5-10210U - 8 Go - 256 Go SSD',
        condition: "refurbished",
        description: "- État : Correct",
      }),
    ).toBe(
      'Reconditionné : PC Portable 14" Dell Latitude 3410 - Core i5-10210U - 8 Go - 256 Go SSD (État Correct)',
    );
  });

  test("coupon on the page: « (Via Coupon) »", () => {
    expect(
      title({
        title: "Perceuse visseuse Makita DF333DSAE 12V",
        extraFacts: JSON.stringify({ coupon: "10 €" }),
      }),
    ).toBe("Perceuse visseuse Makita DF333DSAE 12V (Via Coupon)");
  });
});

describe("games and plans", () => {
  test("Steam game: « sur PC (Dématérialisé - Steam) »", () => {
    expect(
      title(
        { sourceId: "steam", title: "Sherlock Holmes: Crimes and Punishments" },
        "Steam",
      ),
    ).toBe(
      "Sherlock Holmes: Crimes and Punishments sur PC (Dématérialisé - Steam)",
    );
  });

  test("PlayStation game names the console from the facts", () => {
    expect(
      title({
        sourceId: "playstation",
        title: "Astro Bot",
        extraFacts: JSON.stringify({ platforms: ["PS5"] }),
      }),
    ).toBe("Astro Bot sur PS5 (Dématérialisé - PlayStation Store)");
  });

  test("free game", () => {
    expect(
      title(
        { sourceId: "epic", title: "Control", currentPrice: 0 },
        "Epic Games",
      ),
    ).toBe("Control gratuit sur PC (Dématérialisé - Epic Games Store)");
  });

  test("plan for new customers", () => {
    expect(
      title({
        sourceId: "bouygues",
        title: "Forfait B&YOU 100 Go 5G",
        billingPeriod: "month",
        extraFacts: JSON.stringify({
          planTerms: ["Offre réservée aux nouveaux clients", "Sans engagement"],
        }),
      }),
    ).toBe("[Nouveaux clients] Forfait B&YOU 100 Go 5G");
  });
});

describe("140-character cap", () => {
  test("prefix and suffix kept, the core is cut on a block boundary", () => {
    const long = title({
      title: `Cecotec Machine a Café Expresso Power Espresso 20 Cream, ${"Réservoir À Lait 700 Ml, ".repeat(8)}Noir`,
      soldByMerchant: false,
      sellerName: "X",
    });
    expect(long.length).toBeLessThanOrEqual(140);
    expect(long.startsWith("Machine a Café Expresso Cecotec")).toBe(true);
    expect(long.endsWith(" (Vendeur tiers)")).toBe(true);
  });

  test("dealabsTitle still cuts plain titles", () => {
    expect(dealabsTitle("a ".repeat(100)).length).toBeLessThanOrEqual(140);
  });
});

describe("store titles that carry their own tag", () => {
  const cases: Array<[string, string, string]> = [
    [
      "playstation",
      "Planet Zoo (PS5, PlayStation Store)",
      "Planet Zoo sur PS5 (Dématérialisé - PlayStation Store)",
    ],
    [
      "playstation",
      "Cyberpunk 2077 (PS4/PS5, PlayStation Store)",
      "Cyberpunk 2077 sur PS4 et PS5 (Dématérialisé - PlayStation Store)",
    ],
    [
      "nintendo",
      "FINAL FANTASY VII REMAKE INTERGRADE (Nintendo Switch 2, eShop)",
      "FINAL FANTASY VII REMAKE INTERGRADE sur Switch 2 (Dématérialisé - Nintendo eShop)",
    ],
    [
      "xbox",
      "Cyberpunk 2077 (Xbox Series, Xbox Store)",
      "Cyberpunk 2077 sur Xbox Series X|S (Dématérialisé - Microsoft Store)",
    ],
    [
      "gog",
      "Prince of Persia : Les Sables du temps (PC, GOG, sans DRM)",
      "Prince of Persia : Les Sables du temps sur PC (Dématérialisé - GOG)",
    ],
    ["steam", "House Flipper", "House Flipper sur PC (Dématérialisé - Steam)"],
  ];
  test.each(cases)("%s: %s", (sourceId, from, to) => {
    expect(title({ sourceId, title: from })).toBe(to);
  });

  test("free games", () => {
    expect(
      title({
        sourceId: "epic",
        title: "Sorry We're Closed (PC, Epic Games Store)",
        currentPrice: 0,
      }),
    ).toBe(
      "Sorry We're Closed gratuit sur PC (Dématérialisé - Epic Games Store)",
    );
    expect(
      title({
        sourceId: "freegames",
        title: "Galaxy Kart gratuit (Android/iOS)",
        currentPrice: 0,
      }),
    ).toBe("Galaxy Kart gratuit sur Android et iOS (Dématérialisé)");
  });

  test("graphics card: implied type", () => {
    expect(
      title({
        sourceId: "grosbill",
        title: "Gigabyte Radeon RX 9070 XT GAMING OC 16G V1",
      }),
    ).toBe("Carte graphique Gigabyte Radeon RX 9070 XT GAMING OC 16G V1");
  });
});
