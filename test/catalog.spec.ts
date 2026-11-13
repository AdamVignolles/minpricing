import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Alepha } from "alepha";
import { $repository } from "alepha/orm";
import { AlephaServer } from "alepha/server";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  cleanGtin,
  readProductPage,
  readSpecs,
  readJsonLdProduct,
  readShopifyProducts,
  readSitemap,
  robotsAllows,
} from "../src/api/collectors/catalogReaders.ts";
import { DealsController } from "../src/api/controllers/DealsController.ts";
import {
  feedNext,
  feedSince,
  FeedController,
} from "../src/api/controllers/FeedController.ts";
import {
  catalogOfferEntity,
  catalogPriceEntity,
} from "../src/api/entities/CatalogOffer.ts";
import { dealEntity } from "../src/api/entities/Deal.ts";
import { ApiModule } from "../src/api/index.ts";
import {
  CatalogService,
  type PageAnswer,
  parisHour,
} from "../src/api/services/CatalogService.ts";
import {
  isKidsProduct,
  loadCatalogConfig,
  sourceProblem,
  wantedTitle,
  wantedUrls,
  type CatalogSource,
} from "../src/api/services/catalogSources.ts";

const fixture = (name: string) =>
  readFileSync(join(import.meta.dirname, "fixtures/catalog", name), "utf8");

const productPage = (product: Record<string, unknown>) =>
  `<html><head><script type="application/ld+json">${JSON.stringify({
    "@context": "https://schema.org",
    "@type": "Product",
    ...product,
  })}</script></head></html>`;

describe("readJsonLdProduct", () => {
  test("Ocarat product page: brand, EAN, price, stock, rating", () => {
    const product = readJsonLdProduct(fixture("ocarat-product.html"));
    expect(product).toMatchObject({
      title: "Montre Grand Palais 1162/01",
      brand: "Herbelin",
      ean: "3661132108001",
      price: 324.5,
      availability: "in_stock",
    });
    expect(product?.rating).toBeGreaterThan(0);
  });

  test("a listing page (several products) is not a product page", () => {
    const one = { "@type": "Product", name: "A" };
    const html = `<script type="application/ld+json">${JSON.stringify([one, { ...one, name: "B" }])}</script>`;
    expect(readJsonLdProduct(html)).toBeUndefined();
  });

  test("an AggregateOffer gives no single price", () => {
    const product = readJsonLdProduct(
      productPage({
        name: "Montre X",
        offers: { "@type": "AggregateOffer", lowPrice: "99", highPrice: "150" },
      }),
    );
    expect(product?.title).toBe("Montre X");
    expect(product?.price).toBeUndefined();
  });

  test("French price, mpn preferred over sku, bad GTIN dropped", () => {
    const product = readJsonLdProduct(
      productPage({
        name: "Montre Y",
        sku: "12345",
        mpn: "T137.407.11.041.00",
        gtin13: "1234567890123",
        offers: {
          "@type": "Offer",
          price: "1 299,00",
          priceCurrency: "EUR",
          availability: "https://schema.org/OutOfStock",
        },
      }),
    );
    expect(product).toMatchObject({
      reference: "T137.407.11.041.00",
      sku: "12345",
      price: 1299,
      availability: "out_of_stock",
    });
    expect(product?.ean).toBeUndefined();
  });

  test("no block, or a malformed one: undefined", () => {
    expect(readJsonLdProduct("<html></html>")).toBeUndefined();
    expect(
      readJsonLdProduct('<script type="application/ld+json">{oops</script>'),
    ).toBeUndefined();
  });
});

test("cleanGtin checks the digit and pads UPC-A", () => {
  expect(cleanGtin("3661132108001")).toBe("3661132108001");
  expect(cleanGtin("3661132108002")).toBeUndefined();
  expect(cleanGtin("036000291452")).toBe("0036000291452");
  expect(cleanGtin("0000000000000")).toBeUndefined();
  expect(cleanGtin("abc")).toBeUndefined();
});

test("readSitemap tells an index from a list", () => {
  expect(
    readSitemap(
      "<sitemapindex><sitemap><loc>https://a.fr/s1.xml</loc></sitemap></sitemapindex>",
    ),
  ).toEqual({ index: true, urls: ["https://a.fr/s1.xml"] });
  expect(
    readSitemap(
      "<urlset><url><loc><![CDATA[https://a.fr/p?a=1&amp;b=2]]></loc></url></urlset>",
    ),
  ).toEqual({ index: false, urls: ["https://a.fr/p?a=1&b=2"] });
});

describe("robotsAllows", () => {
  const robots = [
    "User-agent: BadBot",
    "Disallow: /",
    "",
    "User-agent: *",
    "Disallow: /panier",
    "Disallow: /*?order=",
    "Allow: /panier/aide",
    "Disallow: /fin$",
  ].join("\n");

  test("only the * group applies", () => {
    expect(robotsAllows(robots, "/montre-x.html")).toBe(true);
  });
  test("longest rule wins, wildcards and $ understood", () => {
    expect(robotsAllows(robots, "/panier/etape")).toBe(false);
    expect(robotsAllows(robots, "/panier/aide")).toBe(true);
    expect(robotsAllows(robots, "/montres?order=prix")).toBe(false);
    expect(robotsAllows(robots, "/fin")).toBe(false);
    expect(robotsAllows(robots, "/fin/suite")).toBe(true);
  });
  test("no file: allowed; Disallow: / for everyone: not", () => {
    expect(robotsAllows("", "/x")).toBe(true);
    expect(robotsAllows("User-agent: *\nDisallow: /", "/x")).toBe(false);
  });
});

test("readShopifyProducts: one row per variant, struck price only when higher", () => {
  const rows = readShopifyProducts(
    {
      products: [
        {
          title: "Aquascaphe",
          handle: "aquascaphe",
          vendor: "Baltic",
          images: [{ src: "https://cdn/a.jpg" }],
          variants: [
            {
              id: 1,
              title: "Bleu",
              sku: "AQ-BL",
              price: "650.00",
              compare_at_price: "700.00",
              available: true,
            },
            {
              id: 2,
              title: "Noir",
              sku: "AQ-NR",
              price: "650.00",
              compare_at_price: "650.00",
              available: false,
            },
          ],
        },
        { title: "Sans variante", handle: "x", variants: [] },
      ],
    },
    "https://shop.example",
  );
  expect(rows).toHaveLength(2);
  expect(rows[0]).toMatchObject({
    externalId: "1",
    title: "Aquascaphe - Bleu",
    brand: "Baltic",
    reference: "AQ-BL",
    price: 650,
    listPrice: 700,
    availability: "in_stock",
    url: "https://shop.example/products/aquascaphe?variant=1",
  });
  expect(rows[1].listPrice).toBeUndefined();
  expect(rows[1].availability).toBe("out_of_stock");
  expect(readShopifyProducts({}, "https://shop.example")).toEqual([]);
});

const SOURCE: CatalogSource = {
  id: "shop",
  name: "Shop",
  reader: "sitemap-jsonld",
  origin: "https://shop.example",
  include: "/montre-",
  exclude: "/blog/",
  titleMustMatch: "montre",
  titleExclude: "bracelet",
  perRun: 10,
  pauseSeconds: 1,
  verified: true,
  enabled: true,
};

test("source config: problems, URL and title filters", () => {
  expect(sourceProblem(SOURCE)).toBeUndefined();
  expect(sourceProblem({ ...SOURCE, origin: "http://shop.example" })).toMatch(
    /origin/,
  );
  expect(sourceProblem({ ...SOURCE, include: "(" })).toMatch(/include/);
  expect(
    sourceProblem({ ...SOURCE, sitemaps: ["https://autre.example/s.xml"] }),
  ).toMatch(/hors du domaine/);
  expect(
    wantedUrls(SOURCE, [
      "https://shop.example/montre-a.html",
      "https://shop.example/montre-a.html",
      "https://shop.example/blog/montre-b.html",
      "https://shop.example/bague-c.html",
      "https://autre.example/montre-d.html",
      "https://shop.example/montre-e.jpg",
    ]),
  ).toEqual(["https://shop.example/montre-a.html"]);
  expect(wantedTitle(SOURCE, "Montre Tissot PRX")).toBe(true);
  expect(wantedTitle(SOURCE, "Bracelet de montre cuir")).toBe(false);
  expect(wantedTitle(SOURCE, "Bague or")).toBe(false);
});

test("feed cursor", () => {
  expect(feedSince(undefined)).toBe("1970-01-01T00:00:00.000Z");
  expect(feedSince("n'importe quoi")).toBe("1970-01-01T00:00:00.000Z");
  expect(feedSince("2026-11-12T10:00:00Z")).toBe("2026-11-12T10:00:00.000Z");
  const a = "2026-11-12T10:00:00.000Z";
  const b = "2026-11-12T10:00:01.000Z";
  expect(feedNext(a, [], false)).toBe(a);
  expect(feedNext(a, [a, b], true)).toBe(b);
  // A full page of one instant: step past it rather than loop.
  expect(feedNext(a, [b, b], true)).toBe("2026-11-12T10:00:01.001Z");
  expect(feedNext(a, [b, b], false)).toBe(b);
});

test("parisHour follows Paris time", () => {
  expect(parisHour(new Date("2026-11-12T23:30:00Z"))).toBe(0);
  expect(parisHour(new Date("2026-07-01T23:30:00Z"))).toBe(1);
});

// ---------------------------------------------------------------- service

const FEED_TOKEN = "feed-token-0123456789abcdef0123456789";
const AGENT_TOKEN = "agent-token-0123456789abcdef0123456789";

/** The shop, as a table of answers; every request is recorded. */
class FakeShop extends CatalogService {
  pages = new Map<string, PageAnswer>();
  requests: string[] = [];
  protected override sleep(): Promise<void> {
    return Promise.resolve();
  }
  protected override async fetchPage(url: string): Promise<PageAnswer> {
    this.requests.push(url);
    return this.pages.get(url) ?? { status: 404, body: "" };
  }
}

class Rows {
  offers = $repository(catalogOfferEntity);
  prices = $repository(catalogPriceEntity);
  deals = $repository(dealEntity);
}

describe("catalogue passes and feed", () => {
  let alepha: Alepha;
  let shop: FakeShop;
  let rows: Rows;
  let dir: string;
  const origin = "https://shop.example";
  const url = (slug: string) => `${origin}/${slug}`;

  const writeConfig = (sources: CatalogSource[]) =>
    writeFileSync(
      join(dir, "config", "watch-sources.json"),
      // A later date than the shipped copy: this file is the one in force.
      JSON.stringify({ updated: "9999-12-31", sources }),
    );

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "catalog-"));
    mkdirSync(join(dir, "config"));
    process.env.APP_FILES_DIR = dir;
    writeConfig([SOURCE]);
    alepha = Alepha.create({
      env: {
        ADMIN_USERNAME: "admin",
        ADMIN_PASSWORD: "s3cret-admin-pass",
        APP_SECRET: "test-app-secret-0123456789abcdef",
        DATABASE_URL: "sqlite://:memory:",
        COLLECT_ON_START: "false",
        FEED_TOKEN,
        AGENT_TOKEN,
      },
    })
      .with(AlephaServer)
      .with({ provide: CatalogService, use: FakeShop })
      .with(ApiModule)
      .with(Rows);
    await alepha.start();
    shop = alepha.inject(CatalogService) as FakeShop;
    rows = alepha.inject(Rows);

    shop.pages.set(url("robots.txt"), {
      status: 200,
      body: `User-agent: *\nDisallow: /montre-interdite\nSitemap: ${url("sitemap.xml")}`,
    });
    shop.pages.set(url("sitemap.xml"), {
      status: 200,
      body: `<sitemapindex><sitemap><loc>${url("produits.xml")}</loc></sitemap></sitemapindex>`,
    });
    shop.pages.set(url("produits.xml"), {
      status: 200,
      body: `<urlset>${[
        "montre-a.html",
        "montre-bracelet.html",
        "montre-partie.html",
        "montre-interdite.html",
        "bague.html",
      ]
        .map((slug) => `<url><loc>${url(slug)}</loc></url>`)
        .join("")}</urlset>`,
    });
    shop.pages.set(url("montre-a.html"), {
      status: 200,
      body: productPage({
        name: "Montre Seiko 5 SRPD55K1",
        brand: { "@type": "Brand", name: "Seiko" },
        mpn: "SRPD55K1",
        gtin13: "4954628232205",
        offers: {
          "@type": "Offer",
          price: "249.00",
          priceCurrency: "EUR",
          availability: "https://schema.org/InStock",
        },
      }),
    });
    shop.pages.set(url("montre-bracelet.html"), {
      status: 200,
      body: productPage({ name: "Bracelet de montre cuir 20 mm" }),
    });
  });

  afterAll(async () => {
    await alepha.stop();
    delete process.env.APP_FILES_DIR;
  });

  test("first pass: lists the sitemap, reads, keeps only watches", async () => {
    const now = new Date("2026-11-12T01:00:00Z");
    const pass = await shop.runSource(SOURCE, now);
    expect(pass).toMatchObject({
      discovered: 4,
      kept: 1,
      gone: 1,
      skipped: 2,
      failed: 0,
    });
    // The page robots.txt forbids was never requested.
    expect(shop.requests).not.toContain(url("montre-interdite.html"));
    const stored = await rows.offers.findMany({});
    const byUrl = new Map(stored.map((row) => [row.url, row]));
    expect(byUrl.get(url("montre-a.html"))).toMatchObject({
      status: "active",
      brand: "Seiko",
      reference: "SRPD55K1",
      ean: "4954628232205",
      price: 249,
      availability: "in_stock",
    });
    expect(byUrl.get(url("montre-bracelet.html"))?.status).toBe("skipped");
    expect(byUrl.get(url("montre-partie.html"))?.status).toBe("gone");
    expect(byUrl.get(url("montre-interdite.html"))?.status).toBe("skipped");
    expect(await rows.prices.findMany({})).toHaveLength(1);
  });

  test("read again before `everyHours`: nothing is requested", async () => {
    shop.requests = [];
    const pass = await shop.runSource(SOURCE, new Date("2026-11-12T03:00:00Z"));
    expect(pass.read).toBe(0);
    expect(shop.requests).toEqual([url("robots.txt")]);
  });

  test("next day: a new price adds one history row, the same price none", async () => {
    const page = shop.pages.get(url("montre-a.html")) as PageAnswer;
    shop.pages.set(url("montre-a.html"), {
      status: 200,
      body: page.body.replace("249.00", "199.00"),
    });
    const pass = await shop.runSource(SOURCE, new Date("2026-11-13T01:30:00Z"));
    expect(pass).toMatchObject({ read: 1, kept: 1, priceChanges: 1 });
    const again = await shop.runSource(
      SOURCE,
      new Date("2026-11-14T02:00:00Z"),
    );
    expect(again.priceChanges).toBe(0);
    expect(await rows.prices.findMany({})).toHaveLength(2);
  });

  test("a 403 stops the pass for that shop", async () => {
    shop.pages.set(url("montre-a.html"), { status: 403, body: "" });
    const pass = await shop.runSource(SOURCE, new Date("2026-11-15T03:00:00Z"));
    expect(pass.stopped).toMatch(/403/);
    expect(pass.kept).toBe(0);
    const row = (await rows.offers.findMany({})).find(
      (r) => r.url === url("montre-a.html"),
    );
    // Not counted as a failed read: the page is fine, we were refused.
    expect(row).toMatchObject({
      status: "active",
      price: 199,
      readFailures: 0,
    });
  });

  test("runDue: only verified and enabled sources, only at active hours", async () => {
    shop.requests = [];
    expect(await shop.runDue(new Date("2026-11-16T12:00:00Z"))).toEqual([]);
    // Not enabled: never touched.
    writeConfig([{ ...SOURCE, enabled: false }]);
    expect(await shop.runDue(new Date("2026-11-16T01:00:00Z"))).toEqual([]);
    expect(shop.requests).toEqual([]);
    // Enabled but unverified: the server probes it itself, once a day,
    // and reads it only if the probe passes (here the shop refuses: 403).
    writeConfig([{ ...SOURCE, verified: false }]);
    expect(await shop.runDue(new Date("2026-11-16T01:00:00Z"))).toEqual([]);
    expect(shop.requests.length).toBeGreaterThan(0);
    expect(shop.probes().shop).toMatchObject({ ok: false });
    shop.requests = [];
    expect(await shop.runDue(new Date("2026-11-16T02:00:00Z"))).toEqual([]);
    expect(shop.requests).toEqual([]);
    writeConfig([SOURCE]);
  });

  test("probe: reads a few pages, writes nothing", async () => {
    shop.pages.set(url("montre-a.html"), {
      status: 200,
      body: productPage({
        name: "Montre Seiko 5",
        offers: { "@type": "Offer", price: "199" },
      }),
    });
    const before = (await rows.offers.findMany({})).map((r) => r.updatedAt);
    const report = await shop.probe("shop");
    expect(report.sitemapUrls).toBe(5);
    expect(report.wantedUrls).toBe(4);
    // One good page out of four: not enough to switch the source on.
    expect(report.ok).toBe(false);
    expect((await rows.offers.findMany({})).map((r) => r.updatedAt)).toEqual(
      before,
    );
    expect((await shop.probe("inconnue")).problem).toMatch(/inconnue/);
  });

  test("feed: closed without the token, the token opens nothing else", async () => {
    const feed = alepha.inject(FeedController);
    const deals = alepha.inject(DealsController);
    const bearer = (token: string) => ({
      headers: { authorization: `Bearer ${token}` },
    });
    await expect(feed.offers.fetch({})).rejects.toMatchObject({ status: 401 });
    await expect(
      feed.offers.fetch(bearer("x".repeat(40))),
    ).rejects.toMatchObject({ status: 401 });
    // The agent token is not a feed token, and the feed token doesn't
    // open the console.
    await expect(feed.offers.fetch(bearer(AGENT_TOKEN))).rejects.toMatchObject({
      status: 401,
    });
    await expect(deals.list.fetch(bearer(FEED_TOKEN))).rejects.toMatchObject({
      status: 401,
    });
    const answer = await feed.offers.fetch(bearer(FEED_TOKEN));
    expect(answer.data.rows).toEqual([]);
  });

  test("feed/offers: every score and status, by source, incremental", async () => {
    const feed = alepha.inject(FeedController);
    const auth = { headers: { authorization: `Bearer ${FEED_TOKEN}` } };
    const base = {
      url: "https://www.timeshop24.fr/x.html",
      currency: "EUR",
      firstSeenAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
    };
    await rows.deals.create({
      ...base,
      sourceId: "timeshop24",
      externalId: "1",
      title: "Montre sous la barre",
      currentPrice: 90,
      score: 12,
      ean: "4894041103495",
      extraFacts: JSON.stringify({ reference: "15540-077" }),
    });
    await rows.deals.create({
      ...base,
      sourceId: "timeshop24",
      externalId: "2",
      title: "Montre archivée",
      currentPrice: 50,
      score: 0,
      status: "archived",
    });
    await rows.deals.create({
      ...base,
      sourceId: "nike",
      externalId: "3",
      title: "Chaussure",
      currentPrice: 60,
      score: 80,
    });
    const page = await feed.offers.fetch({
      ...auth,
      query: { sources: "timeshop24,ocarat" },
    });
    expect(page.data.rows.map((row) => row.title).sort()).toEqual([
      "Montre archivée",
      "Montre sous la barre",
    ]);
    const low = page.data.rows.find((row) => row.externalId === "1");
    expect(low).toMatchObject({
      price: 90,
      ean: "4894041103495",
      status: "active",
    });
    expect(JSON.parse(low.facts).reference).toBe("15540-077");
    expect(page.data.more).toBe(false);
    const later = await feed.offers.fetch({
      ...auth,
      query: { since: new Date(Date.now() + 60_000).toISOString() },
    });
    expect(later.data.rows).toEqual([]);
  });

  test("feed/catalog: read products only, with their price history", async () => {
    const feed = alepha.inject(FeedController);
    const auth = { headers: { authorization: `Bearer ${FEED_TOKEN}` } };
    const page = await feed.catalogOffers.fetch(auth);
    // `skipped` rows (a strap, a forbidden page) are not served.
    expect(page.data.rows.map((row) => row.status).sort()).toEqual([
      "active",
      "gone",
    ]);
    const prices = await feed.catalogPriceHistory.fetch(auth);
    expect(prices.data.rows.map((row) => row.price)).toEqual([249, 199]);
    const sources = await feed.feedSources.fetch(auth);
    expect(sources.data.catalog).toEqual([
      expect.objectContaining({ id: "shop", verified: true, enabled: true }),
    ]);
  });

  test("characteristics are stored and served; a kids' watch leaves", async () => {
    const feed = alepha.inject(FeedController);
    const auth = { headers: { authorization: `Bearer ${FEED_TOKEN}` } };
    const table = `<div class="tab-carac__row"><span>Genre</span><span>Homme</span></div>
      <div class="tab-carac__row"><span>Type de verre</span><span>Verre saphir</span></div>`;
    shop.pages.set(url("montre-a.html"), {
      status: 200,
      body: productPage({
        name: "Montre Seiko 5 SRPD55K1",
        offers: { "@type": "Offer", price: "199.00" },
      }).replace("</html>", `<body>${table}</body></html>`),
    });
    await shop.runSource(SOURCE, new Date("2026-11-20T01:00:00Z"));
    const row = (await rows.offers.findMany({})).find(
      (r) => r.url === url("montre-a.html"),
    );
    expect(JSON.parse(row?.specs ?? "[]")).toEqual([
      { label: "Genre", value: "Homme" },
      { label: "Type de verre", value: "Verre saphir" },
    ]);
    let page = await feed.catalogOffers.fetch(auth);
    const served = page.data.rows.find((r) => r.url === url("montre-a.html"));
    expect(JSON.parse(served.facts).specs).toHaveLength(2);

    // The same page, now a children's watch: left out, served as gone.
    shop.pages.set(url("montre-a.html"), {
      status: 200,
      body: productPage({
        name: "Montre enfant Seiko 5",
        offers: { "@type": "Offer", price: "199.00" },
      }),
    });
    await shop.runSource(SOURCE, new Date("2026-11-21T03:00:00Z"));
    page = await feed.catalogOffers.fetch(auth);
    expect(
      page.data.rows.find((r) => r.url === url("montre-a.html"))?.status,
    ).toBe("gone");
  });

  test("runDue: the shops run side by side", async () => {
    writeConfig([
      { ...SOURCE, activeHours: undefined } as CatalogSource,
      { ...SOURCE, id: "shop-2", name: "Shop 2" },
    ]);
    const passes = await shop.runDue(new Date("2026-11-22T01:00:00Z"));
    expect(passes.map((pass) => pass.sourceId).sort()).toEqual([
      "shop",
      "shop-2",
    ]);
    writeConfig([SOURCE]);
  });
});

describe("readProductPage: characteristics of real pages (13/11/2026)", () => {
  test("hbjo-online jewellers (Azarian, Jean Mick, Émile Léon…)", () => {
    const product = readProductPage(fixture("hbjo-azarian-product.html"));
    expect(product).toMatchObject({
      title: "Montre Tissot Le Locle Powermatic 80",
      price: 745,
      reference: "T006.407.11.033.00",
    });
    expect(product?.specs).toEqual(
      expect.arrayContaining([
        { label: "Genre", value: "Homme" },
        { label: "Matière du bracelet", value: "Acier" },
        { label: "Mouvement", value: "Montre automatique" },
        { label: "Type de verre", value: "Verre saphir" },
        { label: "Etanchéité", value: "30m (3 bar)" },
        { label: "Taille du boîtier", value: "39.3mm" },
      ]),
    );
  });

  test("Maty: supplier reference and EAN from the table", () => {
    const product = readProductPage(fixture("maty-product.html"));
    expect(product).toMatchObject({
      price: 2080,
      reference: "245a45ca",
      ean: "3661132224770",
    });
    expect(product?.specs).toEqual(
      expect.arrayContaining([
        { label: "Genre", value: "Homme" },
        { label: "Matière(s) bracelet", value: "Caoutchouc" },
        { label: "Type de mouvement", value: "Montre automatique" },
      ]),
    );
  });

  test("Horel: features list", () => {
    const product = readProductPage(fixture("horel-product.html"));
    expect(product).toMatchObject({
      reference: "GA-110GB-1AER",
      ean: "4971850943235",
    });
    expect(product?.specs).toEqual(
      expect.arrayContaining([
        { label: "Verre", value: "Minéral durci" },
        { label: "Bracelet", value: "Résine" },
        { label: "Mouvement", value: "Electronique" },
      ]),
    );
  });

  test("several values in a cell stay apart; menus are not specs", () => {
    expect(
      readSpecs(`<table><tr class="feature_1"><td>Genre</td><td>Femme<br>Homme</td></tr></table>
        <ul class="submenu"><li>Genre</li><li>Femme</li><li>Homme</li><li>Enfant</li></ul>
        <p>Livraison : 48 h</p>`),
    ).toEqual([{ label: "Genre", value: "Femme, Homme" }]);
  });
});

test("isKidsProduct: title or « Genre » line", () => {
  expect(isKidsProduct("Montre Enfant Flik Flak")).toBe(true);
  expect(isKidsProduct("Montre Casio Junior")).toBe(true);
  expect(
    isKidsProduct("Montre Tissot", [{ label: "Genre", value: "Enfant" }]),
  ).toBe(true);
  expect(
    isKidsProduct("Montre Tissot", [{ label: "Genre", value: "Femme, Homme" }]),
  ).toBe(false);
  expect(isKidsProduct("Montre Seiko Presage")).toBe(false);
});

test("the shipped watch-sources.json: every entry usable, read all day", () => {
  const config = loadCatalogConfig(
    join(import.meta.dirname, "../config/watch-sources.json"),
  );
  expect(config.sources.map((s) => s.id)).toEqual(
    expect.arrayContaining([
      "jeanmick",
      "maty",
      "horel",
      "emileleon",
      "louispion",
    ]),
  );
  // Ocarat and Bijourama, then the 11 shops asked for on 13/11/2026.
  expect(config.sources).toHaveLength(13);
  expect(config.activeHours).toHaveLength(24);
});
