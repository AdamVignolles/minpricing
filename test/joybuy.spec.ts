import { describe, expect, test } from "vitest";

import {
  joybuyModelQuery,
  joybuyTitle,
  parseJoybuyOffers,
} from "../src/api/collectors/joybuyOffers.ts";

/** A page whose Next.js payload carries the given lightning items. */
function page(items: unknown[]): string {
  const payload = `0:{"initLightningDataList":${JSON.stringify(items)}}`;
  return `<script>self.__next_f.push([1,${JSON.stringify(payload)}])</script>`;
}

describe("Joybuy", () => {
  test("lightning deals from the streamed payload", () => {
    const [deal] = parseJoybuyOffers(
      page([
        {
          skuId: 102725763,
          skuIdStr: "102725763",
          skuName:
            "Midea Bouilloire électrique à réglage de température (40-60-70-80-90-100°C)",
          skuImg: "jfsintlpro-000-product/t1/kettle.jpg",
          brandName: "Midea",
          originalPrice: 49.99,
          originalPriceV2: 49.99,
          realPrice: 17.79,
          finalPrice: 17.79,
          panicbuyingEndTimeText: "10/17 01:59",
        },
      ]),
    );
    expect(deal).toMatchObject({
      externalId: "102725763",
      price: 17.79,
      listPrice: 49.99,
      url: "https://www.joybuy.fr/dp/102725763",
      imageUrl:
        "https://images4.joy-sourcing.com/joybuyimg/jfsintlpro-000-product/t1/kettle.jpg",
    });
    // Joybuy's struck price is a "prix conseillé".
    expect(deal.details?.listPriceKind).toBe("rrp");
  });

  test("no struck price, no deal", () => {
    expect(
      parseJoybuyOffers(
        page([
          {
            skuId: 1,
            skuIdStr: "1",
            skuName: "DJI Mini 5 Pro",
            originalPrice: null,
            realPrice: 1129,
          },
        ]),
      ),
    ).toEqual([]);
  });

  test("promo tags off the title; model query is the brand and model", () => {
    expect(joybuyTitle("【Offres Avant Black Friday】DJI Mic 3 - 2 TX")).toBe(
      "DJI Mic 3 - 2 TX",
    );
    expect(
      joybuyModelQuery("【Offres Avant Black Friday】DJI Mic 3 - 2 TX"),
    ).toBe("DJI Mic 3");
    expect(joybuyModelQuery("METZ 65MUF7000Z TV 65 pouces 165 cm")).toBe(
      "METZ 65MUF7000Z TV 65",
    );
  });
});
