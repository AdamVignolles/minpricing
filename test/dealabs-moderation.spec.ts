import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Alepha } from "alepha";
import { $repository } from "alepha/orm";
import { AlephaServer } from "alepha/server";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

import { dealEntity } from "../src/api/entities/Deal.ts";
import { dealabsDraftEntity } from "../src/api/entities/DealabsDraft.ts";
import { ApiModule } from "../src/api/index.ts";
import { checkModeration } from "../src/api/services/agentConfig.ts";
import {
  AutoPublishService,
  DealNotReadyError,
} from "../src/api/services/AutoPublishService.ts";
import {
  isFromModerators,
  learnFromRejection,
  matchMessageToDraft,
  parseModerationMessage,
  threadPublicStatus,
} from "../src/api/services/dealabsModeration.ts";
import { DealabsModerationService } from "../src/api/services/DealabsModerationService.ts";
import {
  hasProductImage,
  imageFileType,
} from "../src/api/services/DealabsPublisherService.ts";
import {
  applyReadinessFixes,
  assessReadiness,
  DEFAULT_MODERATION_CONFIG,
  foreignLanguage,
  isKnockOffPart,
  lowStockCount,
  type ReadinessInput,
} from "../src/api/services/dealabsReadiness.ts";
import { dealabsTitle } from "../src/api/services/dealTitle.ts";

const shipped = JSON.parse(readFileSync("config/moderation.json", "utf8"));

const RICH =
  "Écran PC 27 pouces QHD 165 Hz. Dalle IPS, temps de réponse 1 ms, FreeSync Premium, pied réglable en hauteur, garantie 3 ans chez le vendeur. Livraison gratuite.";

const input = (
  overrides: Partial<ReadinessInput["deal"]> = {},
  rest: Partial<Omit<ReadinessInput, "deal">> = {},
): ReadinessInput => ({
  deal: {
    sourceId: "amazon",
    title: "Écran PC Samsung Odyssey G5 27 pouces QHD 165 Hz",
    url: "https://www.amazon.fr/dp/B0TEST",
    imageUrl: "https://m.media-amazon.com/images/I/test.jpg",
    categoryId: "informatique",
    soldByMerchant: true,
    currentPrice: 199.99,
    ...overrides,
  },
  draft: {
    title:
      overrides.title ?? "Écran PC Samsung Odyssey G5 27 pouces QHD 165 Hz",
    description: RICH,
  },
  trigger: "schedule",
  config: shipped,
  ...rest,
});

const rule = (readiness: ReturnType<typeof assessReadiness>, name: string) =>
  readiness.checks.find((check) => check.rule === name);

describe("« Prêt pour Dealabs »: the six posts moderators hid (26/10–04/11)", () => {
  test("a clean deal sold by the shop is ready", () => {
    const readiness = assessReadiness(input());
    expect(readiness.status).toBe("ok");
    expect(readiness.checks.every((check) => check.status === "ok")).toBe(true);
  });

  test("DEWALT safety shoes, Screwfix déstockage: local offer, description = title → blocked", () => {
    const title =
      "Chaussures de sécurité DEWALT Halogen Prolite pointure 43 S1P";
    const readiness = assessReadiness(
      input(
        { sourceId: "screwfix", title, currentPrice: 54.99 },
        { draft: { title, description: title } },
      ),
    );
    expect(readiness.status).toBe("block");
    expect(rule(readiness, "local")?.status).toBe("block");
    expect(rule(readiness, "local")?.reason).toMatch(/magasin, la ville/);
    expect(rule(readiness, "completeness")?.status).toBe("block");
  });

  test("Asus ROG Strix G16 without a product image → blocked", () => {
    const readiness = assessReadiness(
      input({
        title: "PC portable Asus ROG Strix G16 RTX 4060 16 Go 512 Go",
        imageUrl: undefined,
      }),
    );
    expect(rule(readiness, "image")?.status).toBe("block");
    expect(readiness.status).toBe("block");
  });

  test("Galaxy Tab A11+ from a Cdiscount marketplace seller below Dealabs' criteria → blocked", () => {
    // In the blocklist (audit).
    const listed = assessReadiness(
      input({
        sourceId: "cdiscount",
        title: "Tablette Samsung Galaxy Tab A11+ 128 Go Wi-Fi",
        soldByMerchant: false,
        sellerName: "AoEn",
        sellerRating: 4.6,
        sellerSalesCount: 420,
      }),
    );
    expect(rule(listed, "seller")?.status).toBe("block");
    expect(rule(listed, "seller")?.reason).toMatch(/AoEn/);
    // Unknown seller passing our gate (≥ 4/5, ≥ 50 sales) but not Dealabs'.
    const thin = assessReadiness(
      input({
        sourceId: "cdiscount",
        title: "Tablette Samsung Galaxy Tab A11+ 128 Go Wi-Fi",
        soldByMerchant: false,
        sellerName: "TECHSHOP EU",
        sellerRating: 4.3,
        sellerSalesCount: 150,
      }),
    );
    expect(rule(thin, "seller")?.status).toBe("block");
    expect(rule(thin, "seller")?.reason).toMatch(/300 ventes/);
    // The brand's own store on the marketplace is fine.
    const official = assessReadiness(
      input({
        sourceId: "cdiscount",
        title: "Samsung Galaxy Tab A11+ 128 Go Wi-Fi",
        soldByMerchant: false,
        sellerName: "Samsung",
      }),
    );
    expect(rule(official, "seller")?.status).toBe("ok");
  });

  test("2 batteries « compatible Makita », no-name Amazon seller → blocked", () => {
    expect(isKnockOffPart("2 batteries compatible Makita 18V 10Ah")).toBe(true);
    expect(isKnockOffPart("Batterie de remplacement pour Dyson V8")).toBe(true);
    expect(isKnockOffPart("Batterie Makita BL1850B 18V 5Ah")).toBe(false);
    const readiness = assessReadiness(
      input({
        title: "2 batteries compatible Makita 18V 10Ah BL1860B",
        soldByMerchant: false,
        sellerName: "Zeroktek",
      }),
    );
    expect(rule(readiness, "seller")?.status).toBe("block");
  });

  test("Glorious switches: Swedish listing, few left → blocked", () => {
    const title =
      "Glorious Gateron Brown Switches 120 st, för mekaniska tangentbord med taktil känsla";
    expect(foreignLanguage(title)).toBe("suédois");
    expect(
      foreignLanguage("Clavier mécanique Glorious GMMK Pro avec switches"),
    ).toBeUndefined();
    expect(foreignLanguage("Apple AirPods Pro 2 with MagSafe case")).toBe(
      undefined,
    );
    const readiness = assessReadiness(
      input(
        { title },
        {
          page: {
            title,
            text: "Il ne reste plus que 3 exemplaire(s) en stock. Livraison gratuite.",
            availability: "https://schema.org/InStock",
          },
        },
      ),
    );
    expect(rule(readiness, "language")?.status).toBe("block");
    expect(rule(readiness, "availability")?.status).toBe("block");
    expect(rule(readiness, "availability")?.reason).toMatch(/Plus que 3/);
    expect(lowStockCount("Plus que 12 exemplaires")).toBe(12);
  });

  test("Roborock F25 LT: price only with a coupon → title and description fixed", () => {
    const title = "Aspirateur balai laveur Roborock F25 LT GEN2";
    const readiness = assessReadiness(
      input(
        { title, currentPrice: 259.99 },
        {
          draft: { title, description: RICH },
          page: {
            title,
            text: "Prix : 299,99 € Appliquer le coupon de 40 € Économisez 40 € avec un coupon",
          },
        },
      ),
    );
    expect(readiness.status).toBe("fix");
    expect(readiness.fixes.titleSuffix).toBe("(Via Coupon)");
    const fixed = applyReadinessFixes(
      { title, description: RICH },
      readiness.fixes,
      dealabsTitle,
    );
    expect(fixed.title).toBe(`${title} (Via Coupon)`);
    expect(fixed.description).toMatch(/coupon/);
    // Already stated: nothing to add.
    const stated = assessReadiness(
      input(
        { title },
        {
          draft: {
            title: `${title} (Via Coupon)`,
            description: `${RICH} Cochez le coupon.`,
          },
          page: { text: "Appliquer le coupon de 40 €" },
        },
      ),
    );
    expect(rule(stated, "price-conditions")?.status).toBe("ok");
  });

  test("the owner's button: blocks are warnings, never refusals", () => {
    const readiness = assessReadiness(
      input({ imageUrl: undefined }, { trigger: "button" }),
    );
    expect(readiness.status).toBe("block");
    expect(readiness.overridable).toBe(true);
    expect(assessReadiness(input({ imageUrl: undefined })).overridable).toBe(
      false,
    );
  });
});

describe("product image in the Dealabs form (#139)", () => {
  test("a real picture counts; icons, logos and avatars don't", () => {
    expect(
      hasProductImage([
        { src: "https://static.dealabs.com/logo.svg", width: 120, height: 40 },
        {
          src: "https://static.dealabs.com/avatars/me.jpg",
          width: 64,
          height: 64,
        },
        { src: "https://static.dealabs.com/x.png", width: 24, height: 24 },
      ]),
    ).toBe(false);
    expect(
      hasProductImage([
        {
          src: "https://static-pepper.dealabs.com/threads/raw/abc/re/300x300/qt/60/abc.jpg",
          width: 180,
          height: 180,
        },
      ]),
    ).toBe(true);
    expect(
      hasProductImage([
        { src: "blob:https://www.dealabs.com/1", width: 200, height: 150 },
      ]),
    ).toBe(true);
  });

  test("uploaded file type read from the bytes", () => {
    expect(imageFileType(new Uint8Array([0xff, 0xd8, 0xff]))?.ext).toBe("jpg");
    expect(imageFileType(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))?.ext).toBe(
      "png",
    );
    expect(imageFileType(new Uint8Array([0x3c, 0x68]))).toBeUndefined();
  });
});

describe("moderators' messages (#140)", () => {
  const cases: Array<[string, string, string]> = [
    [
      "Bonjour, votre deal a été masqué car il est incomplet. Merci d'indiquer le magasin, la ville et le stock restant sous 3 heures, sans quoi il sera supprimé.",
      "incomplete:location-stock",
      "hidden",
    ],
    [
      "Votre deal a été masqué : il manque une image du produit. Merci d'ajouter une photo.",
      "incomplete:image",
      "hidden",
    ],
    [
      "Votre deal a été supprimé : le vendeur ne répond pas aux critères de fiabilité de Dealabs.",
      "seller",
      "deleted",
    ],
    [
      "Nous ne trouvons pas le prix indiqué sur la page du marchand, merci de préciser comment l'obtenir.",
      "incomplete:price",
      "hidden",
    ],
    [
      "Votre deal a été masqué : le produit n'est plus disponible.",
      "availability",
      "hidden",
    ],
    ["Votre deal a été supprimé.", "deleted", "deleted"],
  ];
  test.each(cases)("%s", (text, reason, status) => {
    const parsed = parseModerationMessage(text);
    expect(parsed.reason).toBe(reason);
    expect(parsed.status).toBe(status);
  });

  test("requested items and deadline are quoted", () => {
    const parsed = parseModerationMessage(cases[0][0]);
    expect(parsed.deadlineHours).toBe(3);
    expect(parsed.requested[0]).toMatch(/^Merci d'indiquer le magasin/);
  });

  test("only Dealabs' team counts", () => {
    expect(
      isFromModerators({ from: "L'équipe Dealabs", text: "Bonjour" }),
    ).toBe(true);
    expect(isFromModerators({ text: "Votre deal a été masqué car…" })).toBe(
      true,
    );
    expect(
      isFromModerators({ from: "jean42", text: "Merci pour le deal" }),
    ).toBe(false);
  });

  test("matched to our draft by thread link, else by title", () => {
    const drafts = [
      {
        dealId: "a",
        title: "Aspirateur balai Roborock F25 LT GEN2",
        dealabsUrl:
          "https://www.dealabs.com/bons-plans/aspirateur-balai-roborock-f25-3120456",
      },
      {
        dealId: "b",
        title: "Chaussures de sécurité DEWALT Halogen Prolite",
        dealabsUrl:
          "https://www.dealabs.com/bons-plans/chaussures-dewalt-3125001",
      },
    ];
    expect(
      matchMessageToDraft(
        {
          text: "À propos de https://www.dealabs.com/bons-plans/aspirateur-balai-roborock-f25-3120456 : prix introuvable",
          threadUrls: [],
        },
        drafts,
      )?.dealId,
    ).toBe("a");
    expect(
      matchMessageToDraft(
        {
          text: "Votre deal « Chaussures de sécurité DEWALT Halogen Prolite p.43 » est incomplet",
          threadUrls: [],
        },
        drafts,
      )?.dealId,
    ).toBe("b");
    expect(
      matchMessageToDraft(
        { text: "Bienvenue sur Dealabs", threadUrls: [] },
        drafts,
      ),
    ).toBeUndefined();
  });

  test("a thread's public page", () => {
    expect(threadPublicStatus(200)).toBe("ok");
    expect(threadPublicStatus(404)).toBe("hidden");
    expect(threadPublicStatus(410)).toBe("deleted");
    expect(threadPublicStatus(503)).toBeUndefined();
  });
});

describe("learning from rejections (#141)", () => {
  const base = { ...DEFAULT_MODERATION_CONFIG, ...shipped };
  test("a seller rejection blocks the seller; local and stock rules follow theirs", () => {
    const seller = learnFromRejection(base, {
      reason: "seller",
      sourceId: "cdiscount",
      sellerName: "MEGA DEALZ LTD",
      title: "Tablette",
      at: "2026-11-06T10:00:00Z",
    });
    expect(seller?.config.sellerBlocklist.at(-1)?.name).toBe("MEGA DEALZ LTD");
    expect(
      learnFromRejection(base, {
        reason: "seller",
        sourceId: "cdiscount",
        sellerName: "aoen",
        title: "x",
        at: "2026-11-06",
      }),
    ).toBeUndefined();
    const local = learnFromRejection(base, {
      reason: "incomplete:location-stock",
      sourceId: "lidl",
      title: "Perceuse",
      at: "2026-11-06",
    });
    expect(local?.config.localSources).toContain("lidl");
    const stock = learnFromRejection(base, {
      reason: "availability",
      sourceId: "amazon",
      title: "Switches",
      at: "2026-11-06",
    });
    expect(stock?.config.minStock).toBe(base.minStock + 1);
  });

  test("config/moderation.json: lists only grow, thresholds stay within bounds", () => {
    const grown = {
      ...shipped,
      sellerBlocklist: [...shipped.sellerBlocklist, { name: "New Seller" }],
    };
    expect(checkModeration(shipped, grown).errors).toEqual([]);
    expect(checkModeration(shipped, grown).changes[0]).toMatch(/new seller/);
    const shrunk = { ...shipped, sellerBlocklist: [] };
    expect(checkModeration(shipped, shrunk).errors[0]).toMatch(/seul Adam/);
    const noLocal = { ...shipped, localSources: [] };
    expect(checkModeration(shipped, noLocal).errors[0]).toMatch(
      /source locale/,
    );
    expect(
      checkModeration(shipped, { ...shipped, minSellerRating: 3 }).errors[0],
    ).toMatch(/hors des bornes/);
    expect(
      checkModeration(shipped, {
        ...shipped,
        bounds: { ...shipped.bounds, minStock: [0, 99] },
      }).errors[0],
    ).toMatch(/verrouillé/);
  });
});

class Fixtures {
  deals = $repository(dealEntity);
  drafts = $repository(dealabsDraftEntity);
}

describe("publish path and moderation inbox (integration)", () => {
  let alepha: Alepha;
  let dir: string;
  let fx: Fixtures;
  let publisher: AutoPublishService;
  let moderation: DealabsModerationService;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "moderation-"));
    cpSync("config", join(dir, "config"), { recursive: true });
    process.env.APP_FILES_DIR = dir;
    alepha = Alepha.create({
      env: {
        ADMIN_USERNAME: "admin",
        ADMIN_PASSWORD: "s3cret-admin-pass",
        APP_SECRET: "test-app-secret-0123456789abcdef",
        DATABASE_URL: "sqlite://:memory:",
        COLLECT_ON_START: "false",
        PUBLISH_PAGE_CHECK: "false",
      },
    })
      .with(AlephaServer)
      .with(ApiModule)
      .with(Fixtures);
    await alepha.start();
    fx = alepha.inject(Fixtures);
    publisher = alepha.inject(AutoPublishService);
    moderation = alepha.inject(DealabsModerationService);
  }, 30_000);

  afterAll(async () => {
    vi.restoreAllMocks();
    await alepha?.stop();
    delete process.env.APP_FILES_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  const now = () => new Date().toISOString();
  const makeDeal = async (overrides: Record<string, unknown> = {}) => {
    const deal = await fx.deals.create({
      sourceId: "amazon",
      externalId: `B0${Math.random().toString(36).slice(2, 10)}`,
      title: "Écran PC Samsung Odyssey G5 27 pouces QHD 165 Hz",
      url: "https://www.amazon.fr/dp/B0TEST",
      imageUrl: "https://m.media-amazon.com/images/I/test.jpg",
      description: RICH,
      currentPrice: 199.99,
      listPrice: 299.99,
      firstSeenAt: now(),
      lastSeenAt: now(),
      score: 80,
      ...overrides,
    } as any);
    await fx.drafts.create({
      dealId: deal.id,
      title: deal.title,
      body: deal.title,
      description: RICH,
      generatedAt: now(),
      // An approved title: no « rename once » step in the way.
      titleTrimmed: false,
    } as any);
    return deal;
  };

  test("an evening slot never opens the browser for a post Dealabs would hide", async () => {
    const deal = await makeDeal({ imageUrl: undefined });
    const send = vi
      .spyOn((publisher as any).publisher, "publish")
      .mockResolvedValue({ dealabsUrl: "https://www.dealabs.com/x-1" });
    vi.spyOn(
      (publisher as any).draftService,
      "maybeGenerateDraft",
    ).mockResolvedValue("generated");
    await expect(publisher.publishDeal(deal.id, "schedule")).rejects.toThrow(
      DealNotReadyError,
    );
    expect(send).not.toHaveBeenCalled();
    const draft = await fx.drafts.findOne({
      where: { dealId: { eq: deal.id } },
    });
    // Not a try.
    expect(draft?.publishAttempts ?? 0).toBe(0);
    expect(draft?.lastPublishSteps).toMatch(/Pas d'image produit/);

    // The owner's button goes on, with the warning in its steps, and the
    // publisher is told an image is not required.
    const posted = await publisher.publishDeal(deal.id, "button");
    expect(posted.status).toBe("posted");
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][3]).toEqual({ requireImage: false });
    expect(posted.lastPublishSteps).toMatch(/avertissements/);
    send.mockRestore();
  });

  test("hidden post: filed on the draft, alert until « Vu », checklist learns", async () => {
    const deal = await makeDeal({
      sourceId: "cdiscount",
      title: "Tablette Samsung Galaxy Tab A11+ 128 Go",
      soldByMerchant: false,
      sellerName: "SUPER TABLETTES SARL",
    });
    const draft = (await fx.drafts.findOne({
      where: { dealId: { eq: deal.id } },
    }))!;
    await fx.drafts.updateById(draft.id, {
      status: "posted",
      dealabsUrl:
        "https://www.dealabs.com/bons-plans/tablette-samsung-galaxy-tab-a11-3130001",
      verifiedAt: now(),
    });
    vi.spyOn(moderation as any, "readMessages").mockResolvedValue([
      {
        id: "conv-1",
        from: "L'équipe Dealabs",
        text: "Bonjour, votre deal https://www.dealabs.com/bons-plans/tablette-samsung-galaxy-tab-a11-3130001 a été supprimé : le vendeur ne répond pas aux critères de fiabilité de Dealabs.",
        threadUrls: [],
      },
    ]);
    vi.spyOn(moderation as any, "threadStatus").mockResolvedValue("deleted");
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void) => {
      fn();
      return 0;
    }) as any);
    const pass = await moderation.poll();
    vi.mocked(globalThis.setTimeout).mockRestore();
    expect(pass.changed.some((c) => c.dealId === deal.id)).toBe(true);
    expect(pass.learned).toContain("vendeur bloqué : SUPER TABLETTES SARL");

    const stored = await fx.drafts.getById(draft.id);
    expect(stored.moderationStatus).toBe("deleted");
    expect(stored.moderationReason).toBe("seller");

    const alerts = await moderation.alerts();
    expect(alerts.map((a) => a.dealId)).toContain(deal.id);
    const stats = await moderation.stats(7);
    expect(stats.rejected).toBeGreaterThanOrEqual(1);
    expect(stats.byReason.seller).toBeGreaterThanOrEqual(1);

    await moderation.dismiss(deal.id);
    expect((await moderation.alerts()).map((a) => a.dealId)).not.toContain(
      deal.id,
    );

    // The seller is now in the blocklist the checklist reads.
    const config = publisher.moderationConfig();
    expect(config.sellerBlocklist.map((s) => s.name)).toContain(
      "SUPER TABLETTES SARL",
    );
    const changelog = readFileSync(
      join(dir, "docs", "moderation-changelog.md"),
      "utf8",
    );
    expect(changelog).toMatch(/SUPER TABLETTES SARL/);
  });
});
