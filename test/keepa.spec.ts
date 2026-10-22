import { describe, expect, test } from "vitest";

import {
  amazonAsin,
  keepaChartForDeal,
  keepaChartUrl,
  keepaForDealPage,
} from "../src/api/services/keepa.ts";

describe("keepa", () => {
  test("ASIN from Amazon URLs only", () => {
    expect(amazonAsin("https://www.amazon.fr/dp/B0C2RSJHS6")).toBe(
      "B0C2RSJHS6",
    );
    expect(
      amazonAsin(
        "https://www.amazon.fr/Amazon-Echo-Spot/dp/B0C2RSJHS6/ref=sr_1_1?th=1",
      ),
    ).toBe("B0C2RSJHS6");
    expect(amazonAsin("https://www.amazon.fr/gp/product/B0C2RSJHS6")).toBe(
      "B0C2RSJHS6",
    );
    expect(amazonAsin("https://www.cdiscount.com/f-123-b0c2rsjhs6.html")).toBe(
      undefined,
    );
  });

  test("chart URL: 90 days on amazon.fr", () => {
    const url = new URL(keepaChartUrl("B0C2RSJHS6"));
    expect(url.host).toBe("graph.keepa.com");
    expect(url.searchParams.get("asin")).toBe("B0C2RSJHS6");
    expect(url.searchParams.get("domain")).toBe("fr");
    expect(url.searchParams.get("range")).toBe("90");
  });

  test("only Amazon deals get a chart", () => {
    expect(
      keepaChartForDeal({
        url: "https://www.amazon.fr/dp/B0C2RSJHS6",
        sourceId: "amazon",
      }),
    ).toContain("asin=B0C2RSJHS6");
    expect(
      keepaChartForDeal({
        url: "https://www.lidl.fr/p/x/p100",
        sourceId: "lidl",
      }),
    ).toBe(undefined);
  });
});

describe("keepaForDealPage", () => {
  test("the deal's own ASIN, else the matched Amazon product", () => {
    expect(
      keepaForDealPage({ url: "https://www.amazon.fr/dp/B0C2RSJHS6" }),
    ).toEqual({ asin: "B0C2RSJHS6", sameProductOnAmazon: false });
    expect(
      keepaForDealPage({
        url: "https://www.e.leclerc/fp/x-8806099035273",
        marketPriceUrl: "https://www.amazon.fr/dp/B0DTEST123",
      }),
    ).toEqual({ asin: "B0DTEST123", sameProductOnAmazon: true });
    expect(keepaForDealPage({ url: "https://www.lidl.fr/p/x" })).toBe(null);
  });
});
