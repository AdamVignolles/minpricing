import { describe, expect, it } from "vitest";

import {
  expandShortLink,
  MAX_REDIRECTS,
  resolveLink,
} from "../src/api/services/linkResolver.ts";

/** A fetch that answers from a map of URL → [status, location or body]. */
const fakeFetch = (routes: Record<string, [number, string?]>) => {
  const calls: string[] = [];
  const fetcher = (async (input: string | URL) => {
    const url = String(input);
    calls.push(url);
    const [status, value] = routes[url] ?? [404];
    const redirect = status >= 300 && status < 400;
    return new Response(redirect ? null : (value ?? ""), {
      status,
      headers: redirect && value ? { location: value } : {},
    });
  }) as typeof fetch;
  return { fetcher, calls };
};

const noNetwork = (async () => {
  throw new Error("no network expected");
}) as typeof fetch;

describe("resolveLink", () => {
  it.each([
    [
      "https://www.amazon.fr/Braun-Electrique-3040s/dp/B0DQVFFXN2/ref=sr_1_3?crid=X&tag=abc-21&th=1",
      "amazon",
      "B0DQVFFXN2",
      "https://www.amazon.fr/dp/B0DQVFFXN2",
    ],
    [
      "amazon.fr/gp/product/b08342j6zh?psc=1",
      "amazon",
      "B08342J6ZH",
      "https://www.amazon.fr/dp/B08342J6ZH",
    ],
    [
      "https://www.amazon.fr/gp/aw/d/B09VTHVCCV/",
      "amazon",
      "B09VTHVCCV",
      "https://www.amazon.fr/dp/B09VTHVCCV",
    ],
    [
      "https://www.cdiscount.com/electromenager/petits-appareils-de-cuisson/friteuse-ninja/f-1102002-aaawc85840.html?idOffre=123&cm_mmc=aff#mpos=1",
      "cdiscount",
      "https://www.cdiscount.com/electromenager/petits-appareils-de-cuisson/friteuse-ninja/f-1102002-aaawc85840.html",
      "https://www.cdiscount.com/electromenager/petits-appareils-de-cuisson/friteuse-ninja/f-1102002-aaawc85840.html",
    ],
    [
      "https://m.cdiscount.com/maison/linge/parure/f-1176216-hom5037632621797.html",
      "cdiscount",
      "https://www.cdiscount.com/maison/linge/parure/f-1176216-hom5037632621797.html",
      "https://www.cdiscount.com/maison/linge/parure/f-1176216-hom5037632621797.html",
    ],
    [
      "https://fr.aliexpress.com/item/1005006123456789.html?spm=a2g0o.home&aff_fcid=x&sk=_dXyZ",
      "aliexpress",
      "1005006123456789",
      "https://fr.aliexpress.com/item/1005006123456789.html",
    ],
    [
      "https://www.aliexpress.com/i/1005006123456789.html",
      "aliexpress",
      "1005006123456789",
      "https://fr.aliexpress.com/item/1005006123456789.html",
    ],
    [
      "https://store.steampowered.com/app/1145350/Hades_II/?snr=1_7_15",
      "steam",
      "1145350",
      "https://store.steampowered.com/app/1145350",
    ],
  ])("%s → %s %s", async (input, sourceId, externalId, canonicalUrl) => {
    expect(await resolveLink(input, noNetwork)).toMatchObject({
      ok: true,
      sourceId,
      externalId,
      canonicalUrl,
    });
  });

  it("refuses what is not a link", async () => {
    expect(await resolveLink("super promo", noNetwork)).toMatchObject({
      ok: false,
      reason: "invalid",
    });
    expect(
      await resolveLink("ftp://amazon.fr/dp/B0DQVFFXN2", noNetwork),
    ).toMatchObject({ ok: false, reason: "invalid" });
  });

  it("refuses unsupported shops and lists the accepted ones", async () => {
    const result = await resolveLink(
      "https://www.fnac.com/a12345/produit",
      noNetwork,
    );
    expect(result).toMatchObject({ ok: false, reason: "unsupported" });
    expect(!result.ok && result.message).toContain("Amazon.fr");
    expect(!result.ok && result.message).toContain("Steam");
    // Another Amazon than .fr is another shop (prices, sellers).
    expect(
      await resolveLink("https://www.amazon.de/dp/B0DQVFFXN2", noNetwork),
    ).toMatchObject({ ok: false, reason: "unsupported" });
  });

  it("refuses shop pages that are not a product", async () => {
    expect(
      await resolveLink("https://www.amazon.fr/s?k=ecouteurs", noNetwork),
    ).toMatchObject({ ok: false, reason: "not-a-product" });
    expect(
      await resolveLink(
        "https://www.cdiscount.com/informatique/l-107.html",
        noNetwork,
      ),
    ).toMatchObject({ ok: false, reason: "not-a-product" });
  });

  it("refuses Dealabs links without opening them", async () => {
    const { fetcher, calls } = fakeFetch({});
    expect(
      await resolveLink(
        "https://www.dealabs.com/visit/thread/3123456",
        fetcher,
      ),
    ).toMatchObject({ ok: false, reason: "dealabs" });
    expect(calls).toEqual([]);
  });

  it("follows short links to the product, without loading the shop", async () => {
    const { fetcher, calls } = fakeFetch({
      "https://amzn.to/3xYzAbC": [
        301,
        "https://www.amazon.fr/dp/B0DQVFFXN2?tag=someone-21&linkCode=ll1",
      ],
    });
    expect(await resolveLink("https://amzn.to/3xYzAbC", fetcher)).toMatchObject(
      {
        ok: true,
        sourceId: "amazon",
        externalId: "B0DQVFFXN2",
        canonicalUrl: "https://www.amazon.fr/dp/B0DQVFFXN2",
      },
    );
    expect(calls).toEqual(["https://amzn.to/3xYzAbC"]);
  });

  it("follows chained AliExpress redirects and script redirects", async () => {
    const { fetcher } = fakeFetch({
      "https://s.click.aliexpress.com/e/_DdwXyZ": [
        302,
        "https://click.aliexpress.com/e/next",
      ],
      "https://click.aliexpress.com/e/next": [
        200,
        `<script>window.location.href = "https://fr.aliexpress.com/item/1005006123456789.html?aff_platform=link";</script>`,
      ],
    });
    expect(
      await resolveLink("https://s.click.aliexpress.com/e/_DdwXyZ", fetcher),
    ).toMatchObject({ ok: true, externalId: "1005006123456789" });
  });

  it("refuses a short link leading to Dealabs or nowhere", async () => {
    const { fetcher } = fakeFetch({
      "https://bit.ly/deal": [301, "https://www.dealabs.com/bons-plans/x-123"],
      "https://bit.ly/dead": [404],
    });
    expect(await resolveLink("https://bit.ly/deal", fetcher)).toMatchObject({
      ok: false,
      reason: "dealabs",
    });
    expect(await resolveLink("https://bit.ly/dead", fetcher)).toMatchObject({
      ok: false,
      reason: "unreadable",
    });
  });

  it("caps the redirect chain", async () => {
    const routes: Record<string, [number, string?]> = {};
    for (let i = 0; i < 20; i++) {
      routes[`https://bit.ly/${i}`] = [301, `https://bit.ly/${i + 1}`];
    }
    const { fetcher, calls } = fakeFetch(routes);
    expect(
      await expandShortLink(new URL("https://bit.ly/0"), fetcher),
    ).toBeUndefined();
    expect(calls).toHaveLength(MAX_REDIRECTS);
  });

  it("treats a network error as unreadable", async () => {
    expect(await resolveLink("https://amzn.eu/d/abc", noNetwork)).toMatchObject(
      { ok: false, reason: "unreadable" },
    );
  });
});
