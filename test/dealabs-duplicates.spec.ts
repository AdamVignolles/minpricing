import { describe, expect, it } from "vitest";

import { matchingDuplicate } from "../src/api/services/DealabsPublisherService.ts";

describe("matchingDuplicate", () => {
  it("ignores another product of the same shop", () => {
    // Real case, 2026-10-21: a GOG link got Torchlight II suggested.
    expect(
      matchingDuplicate(
        "Prince of Persia : Les Sables du temps (PC, GOG, sans DRM)",
        1.99,
        [
          {
            url: "https://www.dealabs.com/bons-plans/torchlight-ii-sur-pc-dematerialise-gog-3435602",
            text: "",
          },
        ],
      ),
    ).toBeUndefined();
  });

  it("finds the same product from the item text", () => {
    const suggestion = {
      url: "https://www.dealabs.com/bons-plans/prince-of-persia-3400000",
      text: "Prince of Persia : Les Sables du temps sur PC (GOG)\n1,99 €\nGOG",
    };
    expect(
      matchingDuplicate(
        "Prince of Persia : Les Sables du temps (PC, GOG, sans DRM)",
        1.99,
        [suggestion],
      ),
    ).toBe(suggestion);
  });

  it("errs on the safe side for another game of the same series", () => {
    // The product match compares the name before the colon: a sequel stops
    // the run. A missed post is cheaper than a real duplicate.
    expect(
      matchingDuplicate(
        "Prince of Persia : Les Sables du temps (PC, GOG, sans DRM)",
        1.99,
        [
          {
            url: "https://www.dealabs.com/bons-plans/prince-of-persia-the-lost-crown-sur-pc-3420000",
            text: "",
          },
        ],
      ),
    ).toBeDefined();
  });

  it("falls back to the URL slug when the item has no text", () => {
    const suggestion = {
      url: "https://www.dealabs.com/bons-plans/dragons-dogma-dark-arisen-sur-pc-gog-3410000",
      text: "",
    };
    expect(
      matchingDuplicate(
        "Dragon's Dogma: Dark Arisen (PC, GOG, sans DRM)",
        4.79,
        [suggestion],
      ),
    ).toBe(suggestion);
  });
});
