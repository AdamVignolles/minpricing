import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Alepha } from "alepha";
import { DateTimeProvider } from "alepha/datetime";
import { $repository } from "alepha/orm";
import { AlephaServer, ServerProvider } from "alepha/server";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

import type { RawDeal } from "../src/api/collectors/DealSource.ts";
import { AuthController } from "../src/api/controllers/AuthController.ts";
import { DraftsController } from "../src/api/controllers/DraftsController.ts";
import { agentWriteEntity } from "../src/api/entities/AgentWrite.ts";
import { dealEntity } from "../src/api/entities/Deal.ts";
import { dealabsDraftEntity } from "../src/api/entities/DealabsDraft.ts";
import { ApiModule } from "../src/api/index.ts";
import {
  AutoPublishService,
  PublishRefusedError,
} from "../src/api/services/AutoPublishService.ts";
import { CollectionService } from "../src/api/services/CollectionService.ts";
import {
  checkDealabsTitle,
  DealabsDraftService,
  draftNeedsTitle,
} from "../src/api/services/DealabsDraftService.ts";
import { DealabsSessionService } from "../src/api/services/DealabsSessionService.ts";
import {
  cutText,
  DEAL_FIELD_CAPS,
  fitFields,
} from "../src/api/services/fieldCaps.ts";

describe("field caps (epic 28)", () => {
  test("read from the deals entity: ids and URLs 2 000, title 1 000", () => {
    expect(DEAL_FIELD_CAPS.externalId).toBe(2000);
    expect(DEAL_FIELD_CAPS.url).toBe(2000);
    expect(DEAL_FIELD_CAPS.imageUrl).toBe(2000);
    expect(DEAL_FIELD_CAPS.marketPriceUrl).toBe(2000);
    expect(DEAL_FIELD_CAPS.title).toBe(1000);
    expect(DEAL_FIELD_CAPS.shortTitle).toBe(140);
    // Other text fields keep the default cap, and are covered too.
    expect(DEAL_FIELD_CAPS.sellerName).toBe(255);
  });

  test("a field over its cap is cut, not refused; the rest is untouched", () => {
    const { values, cuts } = fitFields({
      sellerName: `Vendeur ${"très ".repeat(80)}fiable`,
      url: "https://example.com/a",
      currentPrice: 10,
    });
    expect(values.sellerName.length).toBeLessThanOrEqual(255);
    expect(values.sellerName.endsWith("…")).toBe(true);
    expect(values.url).toBe("https://example.com/a");
    expect(values.currentPrice).toBe(10);
    expect(cuts).toEqual([
      { field: "sellerName", length: expect.any(Number), max: 255 },
    ]);
  });

  test("an id or a URL has no words: cut plainly", () => {
    expect(cutText("x".repeat(30), 10)).toBe("x".repeat(10));
  });
});

describe("checkDealabsTitle", () => {
  test("a plain title passes", () => {
    expect(
      checkDealabsTitle('Écran PC gamer incurvé Z-Edge 24" FHD 200 Hz'),
    ).toBeUndefined();
  });
  test.each([
    ["Court", /trop court/],
    ["x ".repeat(80), /trop long/],
    ["Écran incurvé repéré par DealRadar", /DealRadar/],
    ["Écran incurvé à 99,99 €", /prix/],
    ["Écran <b>incurvé</b> 24 pouces", /HTML/],
  ])("refused: %s", (title, reason) => {
    expect(checkDealabsTitle(title)).toMatch(reason);
  });
});

describe("draftNeedsTitle", () => {
  const cut = () => true;
  test("only a cut title nobody approved", async () => {
    expect(await draftNeedsTitle({ titleTrimmed: true }, cut)).toBe(true);
    expect(await draftNeedsTitle({ titleTrimmed: false }, cut)).toBe(false);
    expect(
      await draftNeedsTitle(
        { titleTrimmed: true, titleApprovedAt: "2026-11-05T10:00:00Z" },
        cut,
      ),
    ).toBe(false);
    expect(
      await draftNeedsTitle({ titleTrimmed: true, editedBy: "owner" }, cut),
    ).toBe(false);
    // A draft from before the flag: worked out from the deal.
    expect(await draftNeedsTitle({}, cut)).toBe(true);
    expect(await draftNeedsTitle({}, () => false)).toBe(false);
  });
});

const TOKEN = "e".repeat(64);
/** Wednesday 28 Oct 2026, 17:00 in Paris: a publishing day. */
const WEDNESDAY_17H = "2026-10-28T16:00:00.000Z";

class Fixtures {
  deals = $repository(dealEntity);
  drafts = $repository(dealabsDraftEntity);
  writes = $repository(agentWriteEntity);
}

/** Cdiscount: the externalId is the product page URL (epic 16). */
const LONG_URL = `https://www.cdiscount.com/informatique/ecrans-informatiques/ecran-pc-gamer-incurve-z-edge-24-fhd-1920x1080-200hz-1ms-${"a".repeat(220)}/f-10732-zedge24.html`;
/** Keyword-stuffed marketplace title, well past Dealabs' 140. */
const LONG_TITLE = `Ecran PC Gamer Incurvé - Z-EDGE - 24" - FHD(1920x1080) - 200Hz - 1ms - FreeSync - HDMI DisplayPort - ${"Ultra fin sans bordure, idéal pour le jeu, le bureau et le multimédia, ".repeat(5)}Noir`;

describe("long fields never drop an offer; rename once (epic 28)", () => {
  let alepha: Alepha;
  let dir: string;
  let base: string;
  let fx: Fixtures;
  let drafts: DealabsDraftService;
  let publisher: AutoPublishService;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "title-rename-"));
    cpSync("config", join(dir, "config"), { recursive: true });
    process.env.APP_FILES_DIR = dir;
    alepha = Alepha.create({
      env: {
        ADMIN_USERNAME: "admin",
        ADMIN_PASSWORD: "s3cret-admin-pass",
        APP_SECRET: "test-app-secret-0123456789abcdef",
        AGENT_TOKEN: TOKEN,
        DATABASE_URL: "sqlite://:memory:",
        COLLECT_ON_START: "false",
      },
    })
      .with(AlephaServer)
      .with(ApiModule)
      .with(Fixtures);
    await alepha.start();
    base = `${alepha.inject(ServerProvider).hostname}/api`;
    fx = alepha.inject(Fixtures);
    drafts = alepha.inject(DealabsDraftService);
    publisher = alepha.inject(AutoPublishService);
    vi.spyOn(alepha.inject(DealabsSessionService), "status").mockReturnValue({
      available: true,
      connected: true,
    } as any);
  }, 30_000);

  afterAll(async () => {
    vi.restoreAllMocks();
    await alepha?.stop();
    delete process.env.APP_FILES_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  const upsert = (sourceId: string, raw: RawDeal) =>
    (alepha.inject(CollectionService) as any).upsertDeal(
      sourceId,
      "scrape",
      raw,
    );
  const offer = (overrides: Partial<RawDeal> = {}): RawDeal =>
    ({
      externalId: LONG_URL,
      title: LONG_TITLE,
      url: LONG_URL,
      imageUrl: `https://www.cdiscount.com/pdt2/${"b".repeat(300)}.jpg`,
      price: 99.99,
      listPrice: 179.99,
      currency: "EUR",
      ...overrides,
    }) as RawDeal;

  let longId: string;

  test("a 300-character URL id and a long title are saved whole", async () => {
    expect(LONG_URL.length).toBeGreaterThan(300);
    expect(LONG_TITLE.length).toBeGreaterThan(400);
    const outcome = await upsert("cdiscount", offer());
    expect(outcome.result).toBe("created");
    longId = outcome.dealId;
    const deal = await fx.deals.getById(longId);
    expect(deal.externalId).toBe(LONG_URL);
    expect(deal.url).toBe(LONG_URL);
    expect(deal.title).toBe(LONG_TITLE.replace(/\s+/g, " ").trim());
    expect(deal.shortTitle!.length).toBeLessThanOrEqual(140);
    expect(deal.titleTrimmed).toBe(true);
    expect(outcome.cuts).toBeUndefined();
  });

  test("the same product seen again stays one deal", async () => {
    const again = await upsert("cdiscount", offer({ price: 94.99 }));
    expect(again).toMatchObject({ result: "updated", dealId: longId });
    const rows = await fx.deals.findMany({
      where: { sourceId: { eq: "cdiscount" } },
    });
    expect(rows).toHaveLength(1);
  });

  test("a field still over its cap is cut and reported, the offer kept", async () => {
    const outcome = await upsert(
      "cdiscount",
      offer({
        externalId: "zedge-long-image",
        url: "https://www.cdiscount.com/f-1-zedge.html",
        imageUrl: `https://img.example.com/${"c".repeat(2100)}.jpg`,
      }),
    );
    expect(outcome.result).toBe("created");
    expect(outcome.cuts).toEqual([
      { field: "imageUrl", length: expect.any(Number), max: 2000 },
    ]);
    const deal = await fx.deals.getById(outcome.dealId);
    expect(deal.imageUrl).toHaveLength(2000);
  });

  test("cut title: no publish without a rewritten title, refused before any browser", async () => {
    await drafts.maybeGenerateDraft(await fx.deals.getById(longId));
    const draft = await drafts.ensureDraftForDeal(longId);
    expect(draft?.titleTrimmed).toBe(true);
    expect(await drafts.titleNeedsRewrite(longId)).toBe(true);
    const page = vi.spyOn((publisher as any).pageCheck, "check");
    await expect(publisher.publishDeal(longId, "schedule")).rejects.toThrow(
      PublishRefusedError,
    );
    await expect(publisher.publishDeal(longId, "button")).rejects.toThrow(
      /Titre à réécrire/,
    );
    expect(page).not.toHaveBeenCalled();
    page.mockRestore();
  });

  test("a title that fits in 140 characters needs no step", async () => {
    const outcome = await upsert(
      "cdiscount",
      offer({
        externalId: "short",
        url: "https://www.cdiscount.com/f-1-short.html",
        title: "Écran PC gamer Z-Edge 24 pouces 200 Hz",
      }),
    );
    const deal = await fx.deals.getById(outcome.dealId);
    expect(deal.titleTrimmed).toBe(false);
    expect(deal.shortTitle).toBe(deal.title);
    await drafts.maybeGenerateDraft(deal);
    expect((await drafts.ensureDraftForDeal(deal.id))?.titleTrimmed).toBe(
      false,
    );
    expect(await drafts.titleNeedsRewrite(deal.id)).toBe(false);
  });

  test("the agent's `dealabsTitle` via PUT /agent/schedule approves it on its own", async () => {
    const clock = alepha.inject(DateTimeProvider) as any;
    const saved = clock.ref;
    clock.ref = clock.of(WEDNESDAY_17H);
    const title = 'Écran PC gamer incurvé Z-Edge 24" FHD 200 Hz 1 ms FreeSync';
    const put = (body: unknown) =>
      fetch(`${base}/agent/schedule`, {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${TOKEN}`,
        },
        body: JSON.stringify(body),
      });
    try {
      // A dry run only checks; a broken title is refused, named.
      const dry = await put({
        ranked: [{ dealId: longId, dealabsTitle: `${title} à 99 €` }],
        agent: "deals-select",
        dryRun: true,
      });
      expect(dry.status).toBe(200);
      expect(((await dry.json()) as any).titles).toEqual([
        {
          dealId: longId,
          accepted: false,
          reason: expect.stringMatching(/prix/),
        },
      ]);
      expect(await drafts.titleNeedsRewrite(longId)).toBe(true);

      const real = await put({
        ranked: [{ dealId: longId, title: LONG_TITLE, dealabsTitle: title }],
        agent: "deals-select",
      });
      expect(real.status).toBe(200);
      expect(((await real.json()) as any).titles).toEqual([
        { dealId: longId, accepted: true },
      ]);
      const draft = await drafts.ensureDraftForDeal(longId);
      expect(draft?.title).toBe(title);
      expect(draft?.titleApprovedBy).toBe("deals-select");
      expect(await drafts.titleNeedsRewrite(longId)).toBe(false);
      const audit = await fx.writes.findMany({
        where: { kind: { eq: "title" } },
      });
      expect(audit).toHaveLength(1);
      expect(audit[0].after).toBe(title);

      // Kept on every later pass (collection, publish's rebuild).
      await drafts.maybeGenerateDraft(await fx.deals.getById(longId));
      expect((await drafts.ensureDraftForDeal(longId))?.title).toBe(title);
    } finally {
      clock.ref = saved;
    }
  });

  test("deal page « Titre Dealabs »: the owner's title approves it", async () => {
    const other = await upsert(
      "cdiscount",
      offer({
        externalId: "owner-title",
        url: "https://www.cdiscount.com/f-1-owner.html",
      }),
    );
    await drafts.maybeGenerateDraft(await fx.deals.getById(other.dealId));
    expect(await drafts.titleNeedsRewrite(other.dealId)).toBe(true);

    const login = await alepha.inject(AuthController).login.fetch({
      body: { username: "admin", password: "s3cret-admin-pass" },
    });
    const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
    const controller = alepha.inject(DraftsController);
    // Too long for Dealabs: refused, nothing approved.
    await expect(
      controller.approveTitle.fetch({
        params: { id: other.dealId },
        body: { title: "x ".repeat(80) },
        headers: { cookie },
      }),
    ).rejects.toMatchObject({ status: 422 });
    const { data } = await controller.approveTitle.fetch({
      params: { id: other.dealId },
      body: { title: "Écran PC gamer incurvé Z-Edge 24 pouces 200 Hz" },
      headers: { cookie },
    });
    expect(data.titleApprovedBy).toBe("admin");
    expect(await drafts.titleNeedsRewrite(other.dealId)).toBe(false);
    // An agent never replaces the owner's title.
    expect(
      await drafts.approveTitle(
        other.dealId,
        "Un autre titre pour cet écran incurvé",
        "deals-select",
      ),
    ).toEqual({ ok: false, reason: "titre déjà validé par le propriétaire" });
  });
});
