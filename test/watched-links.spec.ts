import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Alepha } from "alepha";
import { DateTimeProvider } from "alepha/datetime";
import { $repository } from "alepha/orm";
import { AlephaServer } from "alepha/server";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";

import type {
  DealSource,
  ProductRef,
  RawDeal,
} from "../src/api/collectors/DealSource.ts";
import { AuthController } from "../src/api/controllers/AuthController.ts";
import { DealsController } from "../src/api/controllers/DealsController.ts";
import {
  AGENT_LINKS_PER_DAY,
  LinksController,
} from "../src/api/controllers/LinksController.ts";
import { agentWriteEntity } from "../src/api/entities/AgentWrite.ts";
import { dealEntity } from "../src/api/entities/Deal.ts";
import { sourceEntity } from "../src/api/entities/Source.ts";
import { trackedProductEntity } from "../src/api/entities/TrackedProduct.ts";
import { watchedLinkEntity } from "../src/api/entities/WatchedLink.ts";
import { ApiModule } from "../src/api/index.ts";
import { LinkCheckJob } from "../src/api/jobs/LinkCheckJob.ts";
import { CollectionService } from "../src/api/services/CollectionService.ts";
import { DealabsDraftService } from "../src/api/services/DealabsDraftService.ts";
import { DealabsHistoryService } from "../src/api/services/DealabsHistoryService.ts";
import { ItadService } from "../src/api/services/ItadService.ts";
import { linkVerdict } from "../src/api/services/linkVerdict.ts";
import { MarketReferenceService } from "../src/api/services/MarketReferenceService.ts";
import { PriceSeriesService } from "../src/api/services/PriceSeriesService.ts";
import { SeedService } from "../src/api/services/SeedService.ts";
import { WatchedLinkService } from "../src/api/services/WatchedLinkService.ts";

const NOW = "2026-10-29T15:00:00.000Z";
const TOKEN = "l".repeat(64);

/** A good Amazon offer: real drop vs its own 30-day low, well reviewed. */
const goodOffer = (
  asin: string,
  overrides: Partial<RawDeal> = {},
): RawDeal => ({
  externalId: asin,
  title: `Casque Sony WH-1000XM5 ${asin}`,
  url: `https://www.amazon.fr/dp/${asin}`,
  price: 249,
  listPrice: 419,
  currency: "EUR",
  availability: "in_stock",
  merchantId: "amazon",
  categoryHint: "amazon:electronics",
  details: {
    sellerName: "Amazon",
    soldByMerchant: true,
    shippedByMerchant: true,
    productRating: 4.6,
    productReviewCount: 8_000,
    lowestRecentPrice: 379,
  },
  ...overrides,
});

/** Stands in for the Amazon collector: answers from `offers`. */
class FakeAmazon implements DealSource {
  id = "amazon";
  name = "Amazon (test)";
  offers = new Map<string, RawDeal>();
  discovered: RawDeal[] = [];
  asked: ProductRef[] = [];
  async collect(products: ProductRef[]): Promise<RawDeal[]> {
    this.asked.push(...products);
    return products
      .map((product) => this.offers.get(product.externalId ?? ""))
      .filter((deal): deal is RawDeal => !!deal);
  }
  async discover(): Promise<RawDeal[]> {
    return this.discovered;
  }
}

class Fixtures {
  products = $repository(trackedProductEntity);
  sources = $repository(sourceEntity);
  deals = $repository(dealEntity);
  links = $repository(watchedLinkEntity);
  writes = $repository(agentWriteEntity);
}

describe("watched links", () => {
  let alepha: Alepha;
  let dir: string;
  let collection: CollectionService;
  let links: WatchedLinkService;
  let fx: Fixtures;
  let amazon: FakeAmazon;
  let queued: ReturnType<typeof vi.spyOn>;
  const clock = () => alepha.inject(DateTimeProvider) as any;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "watched-links-"));
    process.env.APP_FILES_DIR = dir;
    alepha = Alepha.create({
      env: {
        ADMIN_USERNAME: "admin",
        ADMIN_PASSWORD: "s3cret-admin-pass",
        APP_SECRET: "test-app-secret-0123456789abcdef",
        DATABASE_URL: "sqlite://:memory:",
        COLLECT_ON_START: "false",
        AGENT_TOKEN: TOKEN,
      },
    })
      .with(AlephaServer)
      .with(ApiModule)
      .with(Fixtures);
    await alepha.start();
    collection = alepha.inject(CollectionService);
    links = alepha.inject(WatchedLinkService);
    fx = alepha.inject(Fixtures);
    // No network: enrichment steps and drafts are stubbed.
    vi.spyOn(
      alepha.inject(MarketReferenceService),
      "refreshStale",
    ).mockResolvedValue([]);
    vi.spyOn(
      alepha.inject(DealabsHistoryService),
      "refreshStale",
    ).mockResolvedValue([]);
    vi.spyOn(alepha.inject(ItadService), "refreshStale").mockResolvedValue([]);
    vi.spyOn(
      alepha.inject(PriceSeriesService),
      "refreshLows",
    ).mockResolvedValue([]);
    vi.spyOn(
      alepha.inject(DealabsDraftService),
      "maybeGenerateDraft",
    ).mockResolvedValue(undefined as any);
    // The queue is not under test: checks are run by hand below.
    queued = vi
      .spyOn(alepha.inject(LinkCheckJob).run, "push")
      .mockResolvedValue("job-id");
  }, 30_000);

  afterAll(async () => {
    vi.restoreAllMocks();
    await alepha?.stop();
    delete process.env.APP_FILES_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    clock().ref = clock().of(NOW);
    await fx.deals.deleteMany({});
    await fx.links.deleteMany({});
    amazon = new FakeAmazon();
    queued?.mockClear();
    await fx.writes.deleteMany({});
    (collection as any).collectorsById.amazon = amazon;
  });

  const add = async (url: string) => {
    const result = await links.add(url, "admin");
    if (!result.ok) throw new Error(result.message);
    return result.link;
  };

  test("a link is read by id on its shop's run and becomes a deal", async () => {
    const link = await add(
      "https://www.amazon.fr/Sony/dp/B0BXYCS74H?tag=x-21&th=1",
    );
    amazon.offers.set("B0BXYCS74H", goodOffer("B0BXYCS74H"));
    await collection.runOne("amazon");

    expect(amazon.asked).toEqual([
      {
        id: link.id,
        url: "https://www.amazon.fr/dp/B0BXYCS74H",
        externalId: "B0BXYCS74H",
      },
    ]);
    const deals = await fx.deals.findMany({});
    expect(deals).toHaveLength(1);
    const stored = await links.get(link.id);
    expect(stored.status).toBe("ok");
    expect(stored.dealId).toBe(deals[0].id);
    expect(stored.verdict).toMatch(
      /^Visible : note \d+\/100 à 249 €, 41 % sous le prix barré\.$/,
    );
  });

  test("linked and collected in the same run: one deal", async () => {
    const link = await add("https://amazon.fr/dp/B0BXYCS74H");
    amazon.offers.set("B0BXYCS74H", goodOffer("B0BXYCS74H"));
    amazon.discovered = [
      goodOffer("B0BXYCS74H", { title: "Listing card title" }),
      goodOffer("B0OTHER001"),
    ];
    await collection.runOne("amazon");
    const deals = await fx.deals.findMany({
      where: { externalId: { eq: "B0BXYCS74H" } },
    });
    expect(deals).toHaveLength(1);
    // The link's own product page read wins over the listing card.
    expect(deals[0].title).toContain("Casque Sony");
    expect((await links.get(link.id)).dealId).toBe(deals[0].id);
  });

  test("a product already collected: adding its link points at that deal", async () => {
    amazon.discovered = [goodOffer("B0BXYCS74H")];
    await collection.runOne("amazon");
    const [existing] = await fx.deals.findMany({});
    amazon.discovered = [];

    const link = await add("https://www.amazon.fr/dp/B0BXYCS74H");
    amazon.offers.set("B0BXYCS74H", goodOffer("B0BXYCS74H", { price: 239 }));
    await collection.checkLink(link.id);

    const deals = await fx.deals.findMany({});
    expect(deals).toHaveLength(1);
    expect(deals[0].id).toBe(existing.id);
    expect(deals[0].currentPrice).toBe(239);
    expect((await links.get(link.id)).dealId).toBe(existing.id);
  });

  test("the same link twice is one watch", async () => {
    const first = await links.add(
      "https://www.amazon.fr/dp/B0BXYCS74H",
      "admin",
    );
    const again = await links.add(
      "https://www.amazon.fr/Sony-WH/dp/B0BXYCS74H/ref=x",
      "deals-select",
    );
    expect(first.ok && again.ok).toBe(true);
    expect(again.ok && again.duplicate).toBe(true);
    expect(again.ok && first.ok && again.link.id).toBe(
      first.ok && first.link.id,
    );
    expect(await fx.links.findMany({})).toHaveLength(1);
  });

  test("checkLink reports its steps and the verdict", async () => {
    const link = await add("https://www.amazon.fr/dp/B0BXYCS74H");
    amazon.offers.set("B0BXYCS74H", goodOffer("B0BXYCS74H"));
    const done = await collection.checkLink(link.id);
    const steps = JSON.parse(done.steps ?? "[]");
    expect(steps.map((step: any) => [step.id, step.status])).toEqual([
      ["resolve", "done"],
      ["page", "done"],
      ["market", "skipped"],
      ["dealabs", "skipped"],
      ["score", "done"],
      ["verdict", "done"],
    ]);
    expect(steps[1].detail).toContain("249 €");
    expect(steps[5].detail).toBe(done.verdict);
    expect(done.status).toBe("ok");
  });

  test("an unreadable page fails the check, and the next run retries", async () => {
    const link = await add("https://www.amazon.fr/dp/B0BXYCS74H");
    const failed = await collection.checkLink(link.id);
    expect(failed.status).toBe("failed");
    expect(failed.verdict).toMatch(/Fiche produit illisible/);
    expect(JSON.parse(failed.steps ?? "[]")[1]).toMatchObject({
      id: "page",
      status: "failed",
    });

    amazon.offers.set("B0BXYCS74H", goodOffer("B0BXYCS74H"));
    await collection.runOne("amazon");
    expect((await links.get(link.id)).status).toBe("ok");
  });

  test("blocked product page: falls back to the offer seen on the shop's listings", async () => {
    // Collection saw the product on a listing (card data, no details).
    amazon.discovered = [goodOffer("B0LISTED01", { details: undefined })];
    await collection.runOne("amazon");
    amazon.discovered = [];
    const [listed] = await fx.deals.findMany({});

    // Its product page answers with a bot check: nothing read by id.
    const link = await add("https://www.amazon.fr/dp/B0LISTED01");
    const checked = await collection.checkLink(link.id);
    expect(checked.dealId).toBe(listed.id);
    expect(checked.status).not.toBe("failed");
    expect(checked.verdict).toMatch(
      /^Fiche produit bloquée : évalué sur l'offre vue dans les listes Amazon\.fr le .+ \(sans les détails de la fiche\)\. /,
    );
    expect(JSON.parse(checked.steps ?? "[]")[1]).toMatchObject({
      id: "page",
      status: "done",
      detail: expect.stringContaining("Fiche bloquée : offre des listes"),
    });
    expect(await fx.deals.findMany({})).toHaveLength(1);
  });

  test("blocked and on no recent listing: failed, evaluated once listed", async () => {
    amazon.discovered = [goodOffer("B0LISTED01", { details: undefined })];
    await collection.runOne("amazon");
    amazon.discovered = [];
    // Listed more than 48 h ago: too old to stand for today's price.
    clock().ref = clock().of("2026-11-01T16:00:00.000Z");
    const link = await add("https://www.amazon.fr/dp/B0LISTED01");
    const checked = await collection.checkLink(link.id);
    expect(checked.status).toBe("failed");
    expect(checked.verdict).toMatch(/pas encore vu dans les listes Amazon\.fr/);

    // A later run finds it on a listing: the link is evaluated from it.
    amazon.discovered = [goodOffer("B0LISTED01")];
    await collection.runOne("amazon");
    expect((await links.get(link.id)).status).toBe("ok");
  });

  test("no bypass: the quality gate refuses a linked offer too", async () => {
    const link = await add("https://www.amazon.fr/dp/B0BADREVW1");
    amazon.offers.set(
      "B0BADREVW1",
      goodOffer("B0BADREVW1", {
        details: { productRating: 3.2, productReviewCount: 120 },
      }),
    );
    const checked = await collection.checkLink(link.id);
    expect(checked.status).toBe("refused");
    expect(checked.verdict).toMatch(/^Écarté par le contrôle qualité : /);
    expect(await fx.deals.findMany({})).toHaveLength(0);
    expect(JSON.parse(checked.steps ?? "[]")[4]).toMatchObject({
      id: "score",
      status: "failed",
    });
  });

  test("a refused link is re-evaluated on later runs", async () => {
    const link = await add("https://www.amazon.fr/dp/B0BXYCS74H");
    // At its usual price: no price argument, capped under the bar.
    amazon.offers.set(
      "B0BXYCS74H",
      goodOffer("B0BXYCS74H", {
        price: 379,
        listPrice: undefined,
        details: { ...goodOffer("x").details, lowestRecentPrice: 379 },
      }),
    );
    await collection.runOne("amazon");
    const refused = await links.get(link.id);
    expect(refused.status).toBe("refused");
    expect(refused.verdict).toMatch(/pas d'argument prix|sous le seuil/);

    amazon.offers.set("B0BXYCS74H", goodOffer("B0BXYCS74H"));
    await collection.runOne("amazon");
    expect((await links.get(link.id)).status).toBe("ok");
  });

  test("API: admin adds a link, gets an instant refusal or a queued check", async () => {
    const api = alepha.inject(LinksController);
    const login = await alepha.inject(AuthController).login.fetch({
      body: { username: "admin", password: "s3cret-admin-pass" },
    });
    const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";

    await expect(
      api.addLink.fetch({
        body: { url: "https://www.amazon.fr/dp/B0BXYCS74H" },
      }),
    ).rejects.toMatchObject({ status: 401 });
    // The agent token reads, but adds only through /agent/links.
    await expect(
      api.addLink.fetch({
        headers: { authorization: `Bearer ${TOKEN}` },
        body: { url: "https://www.amazon.fr/dp/B0BXYCS74H" },
      }),
    ).rejects.toMatchObject({ status: 401 });

    const refused = await api.addLink.fetch({
      headers: { cookie },
      body: { url: "https://www.fnac.com/a1/produit" },
    });
    expect(refused.data).toMatchObject({ ok: false, reason: "unsupported" });
    expect(queued).not.toHaveBeenCalled();

    const added = await api.addLink.fetch({
      headers: { cookie },
      body: { url: "https://www.amazon.fr/dp/B0BXYCS74H?tag=x-21" },
    });
    expect(added.data).toMatchObject({
      ok: true,
      duplicate: false,
      link: {
        shop: "Amazon.fr",
        canonicalUrl: "https://www.amazon.fr/dp/B0BXYCS74H",
        status: "pending",
        addedBy: "admin",
      },
    });
    const linkId = added.data.link?.id as string;
    expect(queued).toHaveBeenCalledWith({ linkId });

    const again = await api.addLink.fetch({
      headers: { cookie },
      body: { url: "https://amazon.fr/gp/product/B0BXYCS74H" },
    });
    expect(again.data).toMatchObject({ ok: true, duplicate: true });
    expect(again.data.link?.id).toBe(linkId);

    amazon.offers.set("B0BXYCS74H", goodOffer("B0BXYCS74H"));
    await collection.checkLink(linkId);
    const detail = await api.linkDetail.fetch({
      headers: { authorization: `Bearer ${TOKEN}` },
      params: { id: linkId },
    });
    expect(detail.data).toMatchObject({
      status: "ok",
      deal: { currentPrice: 249, discountPercentage: 41 },
    });
    expect(detail.data.steps.at(-1)).toMatchObject({
      id: "verdict",
      status: "done",
    });

    const list = await api.listLinks.fetch({ headers: { cookie }, query: {} });
    expect(list.data.links.map((link) => link.id)).toEqual([linkId]);
    expect(list.data.shops.map((shop) => shop.label)).toEqual([
      "Amazon.fr",
      "Cdiscount",
      "AliExpress",
      "Steam",
    ]);

    const stopped = await api.stopLink.fetch({
      headers: { cookie },
      params: { id: linkId },
    });
    expect(stopped.data.status).toBe("ended");
  });

  test("API: agents add links, audited and rate-limited", async () => {
    const api = alepha.inject(LinksController);
    const agent = { authorization: `Bearer ${TOKEN}` };
    const res = await api.agentAddLink.fetch({
      headers: agent,
      body: {
        url: "https://store.steampowered.com/app/1145350/Hades_II/",
        agent: "deals-sources",
        reason: "hot on Dealabs last week",
      },
    });
    expect(res.data).toMatchObject({
      ok: true,
      link: {
        sourceId: "steam",
        externalId: "1145350",
        addedBy: "deals-sources",
      },
    });
    const [audit] = await fx.writes.findMany({});
    expect(audit).toMatchObject({
      agent: "deals-sources",
      kind: "link",
      target: "links/steam/1145350",
      reason: "hot on Dealabs last week",
    });
    // A refusal is not a write: not audited.
    const refused = await api.agentAddLink.fetch({
      headers: agent,
      body: {
        url: "https://www.dealabs.com/bons-plans/x-1",
        agent: "deals-sources",
      },
    });
    expect(refused.data).toMatchObject({ ok: false, reason: "dealabs" });
    expect(await fx.writes.findMany({})).toHaveLength(1);

    for (let i = 1; i < AGENT_LINKS_PER_DAY; i++) {
      await fx.writes.create({
        agent: "deals-sources",
        kind: "link",
        target: `links/x/${i}`,
      });
    }
    await expect(
      api.agentAddLink.fetch({
        headers: agent,
        body: {
          url: "https://store.steampowered.com/app/620",
          agent: "deals-sources",
        },
      }),
    ).rejects.toMatchObject({ status: 429 });
  });

  test("lists flag deals added by link", async () => {
    const link = await add("https://www.amazon.fr/dp/B0BXYCS74H");
    amazon.offers.set("B0BXYCS74H", goodOffer("B0BXYCS74H"));
    await collection.checkLink(link.id);
    const deals = alepha.inject(DealsController);
    const page = await deals.list.fetch({
      headers: { authorization: `Bearer ${TOKEN}` },
      query: { status: "active" },
    });
    expect(page.data.content[0].addedByLink).toEqual({
      linkId: link.id,
      addedBy: "admin",
      watched: true,
    });
  });

  test("manual entry retired: tracked products in a supported shop become links", async () => {
    await fx.sources.create({
      id: "manual",
      name: "Saisie manuelle",
      type: "manual",
    });
    await fx.sources.create({
      id: "manual-link",
      name: "Lien",
      type: "manual",
    });
    const amazonProduct = await fx.products.create({
      sourceId: "manual",
      title: "Logitech Combo Touch",
      url: "https://www.amazon.fr/dp/B0D42B3N3W?ref=cm_sw_r_cso_cp_apan_dp_0YR19J0",
    } as any);
    const fnacProduct = await fx.products.create({
      sourceId: "manual",
      title: "Livre Fnac",
      url: "https://www.fnac.com/a1/livre",
    } as any);

    const seed = alepha.inject(SeedService) as any;
    await seed.retireManualSources();
    await seed.migrateTrackedProducts();
    await seed.migrateTrackedProducts();

    expect(await fx.sources.findById("manual")).toBeUndefined();
    expect(await fx.sources.findById("manual-link")).toBeUndefined();
    const [link, ...others] = await fx.links.findMany({});
    expect(others).toEqual([]);
    expect(link).toMatchObject({
      sourceId: "amazon",
      externalId: "B0D42B3N3W",
      addedBy: "migration (produit suivi)",
    });
    expect((await fx.products.getById(amazonProduct.id)).enabled).toBe(false);
    // Unsupported shop: left as is, for the owner to remove.
    expect((await fx.products.getById(fnacProduct.id)).enabled).toBe(true);
    expect((collection as any).collectorsById.manual).toBeUndefined();
  });

  test("the watch ends after its time, and with its expired deal", async () => {
    const old = await add("https://www.amazon.fr/dp/B0BXYCS74H");
    amazon.offers.set("B0BXYCS74H", goodOffer("B0BXYCS74H"));
    await collection.runOne("amazon");

    clock().ref = clock().of("2026-11-13T16:00:00.000Z");
    amazon.asked = [];
    await collection.runOne("amazon");
    expect(amazon.asked).toEqual([]);
    expect((await links.get(old.id)).status).toBe("ended");

    // Unread for 48 h → its deal expires and the watch ends with it.
    const other = await add("https://www.amazon.fr/dp/B0OTHER001");
    amazon.offers.set("B0OTHER001", goodOffer("B0OTHER001"));
    await collection.runOne("amazon");
    amazon.offers.clear();
    clock().ref = clock().of("2026-11-16T16:00:00.000Z");
    await (collection as any).expireUnseen([
      { sourceId: "amazon", collected: 0, created: 0, updated: 0 },
    ]);
    const ended = await links.get(other.id);
    expect(ended.status).toBe("ended");
    expect(ended.verdict).toMatch(/48 h/);
  });
});

describe("link verdicts (same checks as collected deals)", () => {
  test("quality gate refusal, said in French, still watched", () => {
    const verdict = linkVerdict({
      read: true,
      rejected: "produit mal noté (3.2/5 sur 120 avis)",
      shop: "Amazon.fr",
    });
    expect(verdict.status).toBe("refused");
    expect(verdict.verdict).toContain("contrôle qualité : produit mal noté");
    expect(verdict.verdict).toContain("reste surveillé");
  });

  test("no price argument", () => {
    const verdict = linkVerdict({
      read: true,
      deal: { score: 39, currentPrice: 99 },
      warnings: ["Pas d'argument prix : … note plafonnée à 39."],
      shop: "Amazon.fr",
    });
    expect(verdict).toMatchObject({ status: "refused" });
    expect(verdict.verdict).toMatch(/plafonnée : pas d'argument prix/);
  });

  test("under the visibility bar for another reason", () => {
    expect(
      linkVerdict({
        read: true,
        deal: { score: 31, currentPrice: 99 },
        warnings: [],
        shop: "Steam",
      }).verdict,
    ).toMatch(/^Note 31\/100, sous le seuil de visibilité \(40\)/);
  });

  test("already live on Dealabs", () => {
    const verdict = linkVerdict(
      {
        read: true,
        deal: {
          score: 72,
          currentPrice: 249,
          dealabsHistory: JSON.stringify([
            {
              url: "https://www.dealabs.com/bons-plans/casque-sony-123",
              title: "Casque Sony WH-1000XM5",
              price: 249,
              temperature: 412.6,
              publishedAt: "2026-10-27T10:00:00.000Z",
              isExpired: false,
            },
          ]),
        },
        shop: "Amazon.fr",
      },
      new Date(NOW),
    );
    expect(verdict.status).toBe("refused");
    expect(verdict.verdict).toBe(
      "Déjà en ligne sur Dealabs à 249 € (413°), ici 249 € : https://www.dealabs.com/bons-plans/casque-sony-123. Note 72/100, affiché grisé.",
    );
  });

  test("unreadable page", () => {
    expect(linkVerdict({ read: false, shop: "Cdiscount" })).toMatchObject({
      status: "failed",
      verdict: expect.stringContaining(
        "Nouvel essai à chaque passage Cdiscount",
      ),
    });
  });
});
