import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Alepha } from "alepha";
import { $repository } from "alepha/orm";
import { AlephaServer } from "alepha/server";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
  vi,
} from "vitest";

import { dealEntity } from "../src/api/entities/Deal.ts";
import { dealabsDraftEntity } from "../src/api/entities/DealabsDraft.ts";
import { ApiModule } from "../src/api/index.ts";
import { AutoPublishService } from "../src/api/services/AutoPublishService.ts";
import { CollectionService } from "../src/api/services/CollectionService.ts";
import { DealabsHistoryService } from "../src/api/services/DealabsHistoryService.ts";
import { DealabsPublisherService } from "../src/api/services/DealabsPublisherService.ts";
import {
  assessDealPage,
  statedPrice,
} from "../src/api/services/dealPageCheck.ts";
import { DealPageCheckService } from "../src/api/services/DealPageCheckService.ts";
import {
  decideAfterRefresh,
  type RecheckInput,
} from "../src/api/services/priceRecheck.ts";
import { PriceSeriesService } from "../src/api/services/PriceSeriesService.ts";
import { PublishProgressService } from "../src/api/services/PublishProgressService.ts";
import type { PublishRun } from "../src/api/services/publishSteps.ts";

const base: RecheckInput = {
  trigger: "button",
  before: 89,
  after: 89.99,
  score: 62,
  hotChance: 40,
  handPicked: false,
  minScore: 65,
  minHotChance: 20,
};

describe("decideAfterRefresh", () => {
  test("a small rise that keeps the deal visible goes on (button)", () => {
    expect(decideAfterRefresh(base)).toEqual({
      go: true,
      detail: "Prix mis à jour : 89,00 € → 89,99 € (score 62)",
    });
  });

  test("a rise that removes the price argument stops, naming both prices", () => {
    const decision = decideAfterRefresh({ ...base, score: 34 });
    expect(decision).toEqual({
      go: false,
      reason:
        "Pas publié : prix remonté (89,00 € → 89,99 €), deal mis à jour : plus d'argument prix (score 34 < 40)",
    });
  });

  test("automatic publishes keep their own bar", () => {
    expect(decideAfterRefresh({ ...base, trigger: "schedule" })).toMatchObject({
      go: false,
      reason: expect.stringContaining("score 62 < 65"),
    });
    expect(
      decideAfterRefresh({
        ...base,
        trigger: "collection",
        score: 70,
        hotChance: 10,
      }),
    ).toMatchObject({
      go: false,
      reason: expect.stringContaining("10 % < 20 %"),
    });
  });

  test("a hand-added deal is the owner's pick; a live duplicate still stops", () => {
    expect(
      decideAfterRefresh({
        ...base,
        trigger: "schedule",
        score: 20,
        handPicked: true,
      }),
    ).toMatchObject({ go: true });
    expect(
      decideAfterRefresh({
        ...base,
        after: 79,
        duplicate: { price: 78.9, temperature: 210 },
      }),
    ).toMatchObject({
      go: false,
      reason: expect.stringContaining("prix baissé (89,00 € → 79,00 €)"),
    });
  });
});

describe("page check: which price can be trusted", () => {
  const page = { status: 200, title: "Produit", text: "", prices: [] };

  test("one stated price is trusted, several or none are not", () => {
    expect(statedPrice({ ...page, statedPrices: [89.99, 89.99] })).toBe(89.99);
    expect(
      statedPrice({ ...page, statedPrices: [89.99, 12.5] }),
    ).toBeUndefined();
    expect(statedPrice({ ...page, statedPrices: [] })).toBeUndefined();
  });

  test("a price change names the problem, the amount seen and the stated one", () => {
    expect(
      assessDealPage(
        { ...page, prices: [89.99, 4.99], statedPrices: [89.99] },
        { currentPrice: 89 },
      ),
    ).toMatchObject({
      ok: false,
      problem: "price",
      seenPrice: 89.99,
      statedPrice: 89.99,
    });
    expect(
      assessDealPage({ ...page, status: 404 }, { currentPrice: 89 }),
    ).toMatchObject({ ok: false, problem: "gone" });
  });
});

class Fixtures {
  deals = $repository(dealEntity);
  drafts = $repository(dealabsDraftEntity);
}

describe("publishing a deal whose price moved", () => {
  let alepha: Alepha;
  let dir: string;
  let fx: Fixtures;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "price-recheck-"));
    process.env.APP_FILES_DIR = dir;
    alepha = Alepha.create({
      env: {
        ADMIN_USERNAME: "admin",
        ADMIN_PASSWORD: "s3cret-admin-pass",
        APP_SECRET: "test-app-secret-0123456789abcdef",
        DATABASE_URL: "sqlite://:memory:",
        COLLECT_ON_START: "false",
      },
    })
      .with(AlephaServer)
      .with(ApiModule)
      .with(Fixtures);
    await alepha.start();
    fx = alepha.inject(Fixtures);
  }, 30_000);

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await alepha?.stop();
    delete process.env.APP_FILES_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  const makeDeal = async (title: string, price: number) => {
    const deal = await fx.deals.create({
      sourceId: "screwfix",
      externalId: title,
      title,
      url: `https://www.screwfix.fr/${encodeURIComponent(title)}.html`,
      currentPrice: price,
      listPrice: price * 1.6,
      status: "active",
      firstSeenAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
    } as any);
    await fx.drafts.create({
      dealId: deal.id,
      title,
      body: `${title}\n\nUn bon prix.`,
      description: "Un bon prix.",
      generatedAt: new Date().toISOString(),
    } as any);
    return deal;
  };

  const pagePrice = (seen: number, stated?: number) => {
    vi.spyOn(
      alepha.inject(DealabsHistoryService),
      "findLiveDuplicate",
    ).mockResolvedValue(undefined as any);
    vi.spyOn(alepha.inject(DealPageCheckService), "check").mockResolvedValue({
      ok: false,
      problem: "price",
      reason: `le prix a changé : … la page affiche ${seen} €`,
      seenPrice: seen,
      statedPrice: stated,
    } as any);
    vi.spyOn(
      alepha.inject(PriceSeriesService),
      "chartImageUrl",
    ).mockResolvedValue(undefined as any);
  };

  test("a listing-only shop takes the page's stated price: deal updated, then published", async () => {
    const deal = await makeDeal("Perceuse DEWALT DCD706D2", 89);
    pagePrice(89.99, 89.99);
    vi.spyOn(
      alepha.inject(CollectionService),
      "refreshDeal",
    ).mockImplementation(async (id, price) => {
      const before = (await fx.deals.getById(id)).currentPrice;
      await fx.deals.updateById(id, { currentPrice: price, score: 60 });
      return {
        read: "page" as const,
        before,
        after: price,
        deal: await fx.deals.getById(id),
        handPicked: false,
      };
    });
    const publish = vi
      .spyOn(alepha.inject(DealabsPublisherService), "publish")
      .mockResolvedValue({
        dealabsUrl: "https://www.dealabs.com/bons-plans/x-1",
      });

    const posted = await alepha
      .inject(AutoPublishService)
      .publishDeal(deal.id, "button");
    expect(posted.status).toBe("posted");
    expect(publish.mock.calls[0][0].currentPrice).toBe(89.99);
    const trail = JSON.parse(posted.lastPublishSteps ?? "{}") as PublishRun;
    const step = trail.steps.find((item) => item.id === "merchant-check");
    expect(step?.status).toBe("done");
    expect(step?.detail).toContain("Prix mis à jour : 89,00 € → 89,99 €");
    expect(step?.priceChange).toEqual({ from: 89, to: 89.99 });
  });

  test("a rise that kills the deal stops before any attempt is counted", async () => {
    const deal = await makeDeal("Meuleuse Makita GA5030", 49);
    pagePrice(69);
    vi.spyOn(
      alepha.inject(CollectionService),
      "refreshDeal",
    ).mockImplementation(async (id) => {
      await fx.deals.updateById(id, { currentPrice: 69, score: 30 });
      return {
        read: "shop" as const,
        before: 49,
        after: 69,
        deal: await fx.deals.getById(id),
        handPicked: false,
      };
    });
    const publish = vi.spyOn(alepha.inject(DealabsPublisherService), "publish");
    await expect(
      alepha.inject(AutoPublishService).publishDeal(deal.id, "button"),
    ).rejects.toThrow("plus d'argument prix (score 30 < 40)");
    expect(publish).not.toHaveBeenCalled();
    const draft = await fx.drafts.findOne({
      where: { dealId: { eq: deal.id } },
    });
    expect(draft?.publishAttempts ?? 0).toBe(0);
    const { last } = await alepha.inject(PublishProgressService).get();
    expect(last?.error).toContain("49,00 € → 69,00 €");
  });

  test("page shows our price but the shop's reader disagrees: the shop wins", async () => {
    const deal = await makeDeal("Pokemon Battle Disc", 22.95);
    vi.spyOn(
      alepha.inject(DealabsHistoryService),
      "findLiveDuplicate",
    ).mockResolvedValue(undefined as any);
    vi.spyOn(alepha.inject(DealPageCheckService), "check").mockResolvedValue({
      ok: true,
      matchedPrice: 22.95,
    } as any);
    vi.spyOn(
      alepha.inject(CollectionService),
      "refreshDeal",
    ).mockImplementation(async (id, pagePrice) => {
      expect(pagePrice).toBeUndefined();
      await fx.deals.updateById(id, { currentPrice: 32.4, score: 30 });
      return {
        read: "shop" as const,
        before: 22.95,
        after: 32.4,
        deal: await fx.deals.getById(id),
        handPicked: false,
      };
    });
    const publish = vi.spyOn(alepha.inject(DealabsPublisherService), "publish");
    await expect(
      alepha.inject(AutoPublishService).publishDeal(deal.id, "button"),
    ).rejects.toThrow("22,95 € → 32,40 €");
    expect(publish).not.toHaveBeenCalled();
  });

  test("page OK and no reader for the shop: published as before", async () => {
    const deal = await makeDeal("Visseuse Ryobi", 59.99);
    vi.spyOn(
      alepha.inject(DealabsHistoryService),
      "findLiveDuplicate",
    ).mockResolvedValue(undefined as any);
    vi.spyOn(alepha.inject(DealPageCheckService), "check").mockResolvedValue({
      ok: true,
    } as any);
    vi.spyOn(
      alepha.inject(PriceSeriesService),
      "chartImageUrl",
    ).mockResolvedValue(undefined as any);
    vi.spyOn(
      alepha.inject(DealabsPublisherService),
      "publish",
    ).mockResolvedValue({
      dealabsUrl: "https://www.dealabs.com/bons-plans/y-2",
    });
    const posted = await alepha
      .inject(AutoPublishService)
      .publishDeal(deal.id, "button");
    expect(posted.status).toBe("posted");
    const trail = JSON.parse(posted.lastPublishSteps ?? "{}") as PublishRun;
    expect(
      trail.steps.find((step) => step.id === "merchant-check")?.detail,
    ).toBe("Page en ligne, produit disponible au bon prix");
  });

  test("unreadable shop: stops as before, saying the deal wasn't updated", async () => {
    const deal = await makeDeal("Scie Bosch PKS 55", 99);
    pagePrice(109);
    vi.spyOn(alepha.inject(CollectionService), "refreshDeal").mockResolvedValue(
      {
        read: "none",
        before: 99,
        reason: "la page n'indique pas un prix unique pour le produit",
      },
    );
    await expect(
      alepha.inject(AutoPublishService).publishDeal(deal.id, "button"),
    ).rejects.toThrow("deal non mis à jour");
  });

  test("refreshDeal applies a stated page price for a shop without collect()", async () => {
    const deal = await fx.deals.create({
      sourceId: "screwfix",
      externalId: "603TR",
      title: "Perceuse visseuse DEWALT DCD706D2-QW",
      url: "https://www.screwfix.fr/603tr.html",
      currentPrice: 169.99,
      listPrice: 199.99,
      status: "active",
      firstSeenAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
    } as any);
    const refresh = await alepha
      .inject(CollectionService)
      .refreshDeal(deal.id, 159.99);
    expect(refresh).toMatchObject({
      read: "page",
      before: 169.99,
      after: 159.99,
    });
    const stored = await fx.deals.getById(deal.id);
    expect(stored.currentPrice).toBe(159.99);
    expect(stored.listPrice).toBe(199.99);

    const none = await alepha.inject(CollectionService).refreshDeal(deal.id);
    expect(none).toMatchObject({ read: "none" });
  });
});
