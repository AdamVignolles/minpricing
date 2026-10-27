import { describe, expect, it } from "vitest";

import {
  isShortLink,
  LinkError,
  MANUAL_LINK_SOURCE,
  resolveLink,
} from "../src/api/services/linkResolver.ts";

describe("resolveLink", () => {
  it("extracts the ASIN and drops tracking params", () => {
    const resolved = resolveLink(
      "https://www.amazon.fr/Some-Product-Name/dp/b0abc12345/ref=sr_1_3?tag=x&th=1",
    );
    expect(resolved).toMatchObject({
      sourceId: "amazon",
      externalId: "B0ABC12345",
      canonicalUrl: "https://www.amazon.fr/dp/B0ABC12345",
    });
  });

  it("handles /gp/product ASIN links", () => {
    expect(
      resolveLink("https://amazon.fr/gp/product/B000000001?psc=1").externalId,
    ).toBe("B000000001");
  });

  it("uses the clean URL as Cdiscount id", () => {
    const resolved = resolveLink(
      "https://www.cdiscount.com/informatique/f-107-abc.html?idOffre=1#x",
    );
    expect(resolved.sourceId).toBe("cdiscount");
    expect(resolved.externalId).toBe(
      "https://www.cdiscount.com/informatique/f-107-abc.html",
    );
  });

  it("reads Steam app ids and AliExpress item ids", () => {
    expect(
      resolveLink("https://store.steampowered.com/app/620/Portal_2/"),
    ).toMatchObject({ sourceId: "steam", externalId: "620" });
    expect(
      resolveLink("https://fr.aliexpress.com/item/1005001234567890.html?spm=a"),
    ).toMatchObject({ sourceId: "aliexpress", externalId: "1005001234567890" });
  });

  it("falls back to manual-link with a canonical URL", () => {
    const resolved = resolveLink(
      "https://www.Lidl.fr/p/some-thing/p123/?utm=1",
    );
    expect(resolved.sourceId).toBe(MANUAL_LINK_SOURCE);
    expect(resolved.externalId).toBe("https://www.lidl.fr/p/some-thing/p123");
  });

  it("rejects invalid and unsafe links", () => {
    expect(() => resolveLink("not a url")).toThrow(LinkError);
    expect(() => resolveLink("ftp://example.com/x")).toThrow(LinkError);
    expect(() => resolveLink("http://localhost:3000/x")).toThrow(LinkError);
    expect(() => resolveLink("http://169.254.169.254/latest")).toThrow(
      LinkError,
    );
  });

  it("detects short links", () => {
    expect(isShortLink("https://amzn.to/3abc")).toBe(true);
    expect(isShortLink("https://www.amazon.fr/dp/B000000001")).toBe(false);
  });
});
