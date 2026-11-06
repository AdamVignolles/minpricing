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
import {
  AutoPublishService,
  PublishRefusedError,
} from "../src/api/services/AutoPublishService.ts";
import type { DealabsThread } from "../src/api/services/dealabsSearch.ts";
import {
  currentDealabsStatus,
  dealabsThreadId,
  matchProfilePosts,
  othersLiveOnDealabs,
  republishVerdict,
  STATUS_HISTORY_MAX,
  statusSummaryLine,
  threadPageStatus,
  withChange,
} from "../src/api/services/dealabsStatus.ts";
import { DealabsStatusService } from "../src/api/services/DealabsStatusService.ts";
import { MyDealabsPostsService } from "../src/api/services/MyDealabsPostsService.ts";

const fixture = (name: string) =>
  readFileSync(join("test/fixtures/dealabs", name), "utf8");

const post = (overrides: Partial<DealabsThread>): DealabsThread => ({
  id: "3446230",
  title: "Enceinte Bluetooth portable Go 4 Noir JBL (via retrait magasin)",
  price: 24.99,
  temperature: 406.28,
  isHot: true,
  isExpired: false,
  publishedAt: "2026-11-04T15:03:52.000Z",
  merchant: "Carrefour",
  url: "https://www.dealabs.com/share-deal/3446230",
  poster: "Adam_Vignolles",
  ...overrides,
});

describe("Dealabs status (epic 32): pure rules", () => {
  test("thread ids from a thread link and from the profile's share link", () => {
    expect(
      dealabsThreadId(
        "https://www.dealabs.com/bons-plans/asus-rog-strix-g16-16-fhd-165hz-ryzen-9-8940hx-rtx-5060-16go-512go-w11-3445887",
      ),
    ).toBe("3445887");
    expect(dealabsThreadId("https://www.dealabs.com/share-deal/3446484")).toBe(
      "3446484",
    );
    // The submission form's URL is not a post.
    expect(
      dealabsThreadId(
        "https://www.dealabs.com/submission/bons-plans/add?thread_created_location=thread_type_selection",
      ),
    ).toBeUndefined();
    expect(dealabsThreadId(undefined)).toBeUndefined();
  });

  test("a post's page, as Dealabs served them on 06/11", () => {
    expect(
      threadPageStatus({
        status: 200,
        html: fixture("thread-live-3446230.html"),
        threadId: "3446230",
        finalUrl:
          "https://www.dealabs.com/bons-plans/enceinte-bluetooth-portable-go-4-noir-jbl-3446230",
      }),
    ).toBe("live");
    expect(
      threadPageStatus({
        status: 200,
        html: fixture("thread-expired-3441527.html"),
        threadId: "3441527",
      }),
    ).toBe("expired");
    // The Asus ROG Strix post removed by the moderators answered 410.
    expect(threadPageStatus({ status: 410 })).toBe("deleted");
    expect(threadPageStatus({ status: 404 })).toBe("deleted");
    expect(
      threadPageStatus({
        status: 200,
        html: "<p>Ce deal est en attente de modération</p>",
        threadId: "1",
      }),
    ).toBe("hidden");
    expect(
      threadPageStatus({
        status: 200,
        html: "x",
        threadId: "3446230",
        finalUrl: "https://www.dealabs.com/bons-plans",
      }),
    ).toBe("deleted");
  });

  test("never a downgrade on an unreadable answer", () => {
    expect(threadPageStatus({ status: 503 })).toBeUndefined();
    expect(threadPageStatus({ status: 403 })).toBeUndefined();
    expect(
      threadPageStatus({
        status: 200,
        html: "<title>Just a moment...</title> challenge-platform",
        threadId: "3446230",
      }),
    ).toBeUndefined();
  });

  test("profile posts matched to drafts: link first, then product and shop", () => {
    const drafts = [
      {
        id: "d1",
        dealId: "a",
        status: "posted",
        dealabsUrl:
          "https://www.dealabs.com/bons-plans/enceinte-bluetooth-portable-go-4-noir-jbl-3446230",
      },
      { id: "d2", dealId: "b", status: "draft" },
      { id: "d3", dealId: "c", status: "draft" },
    ];
    const deals = [
      {
        id: "a",
        title: "Enceinte JBL Go 4 Noir",
        currentPrice: 24.99,
        sourceId: "carrefour",
      },
      {
        id: "b",
        title:
          "Micro-Ondes Cecotec Proclean 5130 - 23L, Grill 1000W, Micro-Ondes 800W",
        currentPrice: 66.99,
        sourceId: "amazon",
      },
      {
        id: "c",
        title: "Montre Edox Neptunian Automatic 80120-3VM-VDN1",
        currentPrice: 915,
        sourceId: "amazon",
      },
    ];
    const matches = matchProfilePosts(
      [
        post({}),
        post({
          id: "3446007",
          title:
            "Micro-Ondes Cecotec Proclean 5130 - 23L, Grill 1000W, Micro-Ondes 800W, 5 Niveaux de Puissance",
          price: 66.99,
          merchant: "Amazon",
          url: "https://www.dealabs.com/share-deal/3446007",
        }),
        // Same watch, but posted at Ocarat: not our Amazon deal.
        post({
          id: "3446160",
          title: "Montre Edox Neptunian Automatic 80120-3VM-VDN1",
          price: 915,
          merchant: "Ocarat",
          url: "https://www.dealabs.com/share-deal/3446160",
        }),
      ],
      drafts,
      deals,
    );
    expect(matches.map((m) => [m.post.id, m.dealId, m.by])).toEqual([
      ["3446230", "a", "url"],
      ["3446007", "b", "product"],
    ]);
  });

  test("history keeps the last 20 changes", () => {
    let history: string | undefined;
    for (let i = 0; i < 25; i++) {
      history = withChange(history, {
        at: `2026-11-06T10:${String(i).padStart(2, "0")}:00Z`,
        to: i % 2 ? "live" : "expired",
        source: "profile",
      });
    }
    const list = JSON.parse(history!);
    expect(list).toHaveLength(STATUS_HISTORY_MAX);
    expect(list.at(-1).at).toBe("2026-11-06T10:24:00Z");
  });

  test("a draft posted before epic 32 counts as live until checked", () => {
    expect(currentDealabsStatus({ status: "posted" })).toBe("live");
    expect(currentDealabsStatus({ status: "draft" })).toBe("not_published");
    expect(
      currentDealabsStatus({ status: "posted", dealabsStatus: "deleted" }),
    ).toBe("deleted");
  });

  test("republish rules (owner's decisions, 2026-11-05)", () => {
    const base = {
      currentPrice: 59.99,
      othersLive: false,
      readiness: "ok" as const,
    };
    expect(republishVerdict({ ...base, status: "live" }).allowed).toBe(false);
    // Expired: price back at or under our post's.
    expect(
      republishVerdict({ ...base, status: "expired", postedPrice: 49.99 }),
    ).toMatchObject({ allowed: false, reason: /au-dessus/ });
    const back = republishVerdict({
      ...base,
      status: "expired",
      postedPrice: 59.99,
    });
    expect(back).toMatchObject({ allowed: true });
    expect(back.reason).toMatch(/prix revenu à 59,99 €/);
    // Never while someone else's post is live.
    expect(
      republishVerdict({
        ...base,
        status: "expired",
        postedPrice: 70,
        othersLive: true,
      }).allowed,
    ).toBe(false);
    // Hidden / deleted: once « Prêt pour Dealabs » passes.
    expect(
      republishVerdict({ ...base, status: "deleted", readiness: "block" })
        .allowed,
    ).toBe(false);
    expect(
      republishVerdict({
        ...base,
        status: "hidden",
        moderationReason: "incomplete:image",
      }),
    ).toMatchObject({ allowed: true, reason: /masqué.*cause réglée/ });
  });

  test("someone else's live post, ours left out", () => {
    const now = new Date("2026-11-06T10:00:00Z");
    const history = JSON.stringify([
      {
        url: "https://www.dealabs.com/bons-plans/x-1",
        price: 20,
        temperature: 50,
        publishedAt: "2026-11-05T10:00:00Z",
        isExpired: false,
        mine: true,
      },
    ]);
    expect(othersLiveOnDealabs(history, 20, now)).toBe(false);
    expect(
      othersLiveOnDealabs(
        history.replace('"mine":true', '"mine":false'),
        20,
        now,
      ),
    ).toBe(true);
  });

  test("run-log line", () => {
    expect(
      statusSummaryLine({
        live: 24,
        expired: 3,
        hidden: 1,
        deleted: 1,
        attached: 2,
        changes: 4,
      }),
    ).toBe(
      "Dealabs : 24 en ligne, 3 expiré(s), 1 masqué(s), 1 supprimé(s), 2 publié(s) à la main rattaché(s), 4 changement(s)",
    );
  });
});

class Fixtures {
  deals = $repository(dealEntity);
  drafts = $repository(dealabsDraftEntity);
}

const RICH =
  "Enceinte portable étanche IP67, 7 heures d'autonomie, Bluetooth 5.3, son JBL Pro, dragonne intégrée. Livraison gratuite.";

describe("DealabsStatusService and its effects (integration)", () => {
  let alepha: Alepha;
  let dir: string;
  let fx: Fixtures;
  let service: DealabsStatusService;
  let publisher: AutoPublishService;
  const now = () => new Date().toISOString();

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "dealabs-status-"));
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
    service = alepha.inject(DealabsStatusService);
    publisher = alepha.inject(AutoPublishService);
    // No real pacing in tests.
    vi.spyOn((service as any).history, "waitForSlot").mockResolvedValue(
      undefined,
    );
  }, 30_000);

  afterAll(async () => {
    vi.restoreAllMocks();
    await alepha?.stop();
    delete process.env.APP_FILES_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  const makeDeal = async (
    overrides: Record<string, unknown>,
    draft: Record<string, unknown> = {},
  ) => {
    const deal = await fx.deals.create({
      sourceId: "amazon",
      externalId: `B0${Math.random().toString(36).slice(2, 10)}`,
      url: "https://www.amazon.fr/dp/B0TEST",
      imageUrl: "https://m.media-amazon.com/images/I/test.jpg",
      description: RICH,
      currentPrice: 24.99,
      listPrice: 39.99,
      firstSeenAt: now(),
      lastSeenAt: now(),
      score: 80,
      ...overrides,
    } as any);
    const row = await fx.drafts.create({
      dealId: deal.id,
      title: deal.title,
      body: deal.title,
      description: RICH,
      generatedAt: now(),
      titleTrimmed: false,
      ...draft,
    } as any);
    return { deal, draft: row };
  };

  test("a run: expired on the profile, posted by hand attached, gone post deleted, unreadable kept", async () => {
    const expired = await makeDeal(
      {
        title: "Berserk and the Band of the Hawk sur PS4",
        sourceId: "playstation",
        currentPrice: 23.99,
      },
      {
        status: "posted",
        dealabsUrl:
          "https://www.dealabs.com/bons-plans/berserk-and-the-band-of-the-hawk-ps4-playstation-store-3441527",
      },
    );
    const byHand = await makeDeal({
      title:
        "Micro-Ondes Cecotec Proclean 5130 - 23L, Grill 1000W, Micro-Ondes 800W",
      currentPrice: 66.99,
    });
    const gone = await makeDeal(
      { title: "Asus ROG STRIX G16 RTX 5060 16Go 512Go", currentPrice: 1199 },
      {
        status: "posted",
        dealabsUrl:
          "https://www.dealabs.com/bons-plans/asus-rog-strix-g16-3445887",
      },
    );
    const unreadable = await makeDeal(
      { title: "Lime à bande Parkside", sourceId: "lidl", currentPrice: 24.99 },
      {
        status: "posted",
        dealabsUrl: "https://www.dealabs.com/bons-plans/lime-parkside-3438677",
      },
    );
    vi.spyOn(
      alepha.inject(MyDealabsPostsService),
      "postsFresh",
    ).mockResolvedValue([
      post({
        id: "3441527",
        title: "Berserk and the Band of the Hawk sur PS4 (Dématérialisé)",
        price: 23.99,
        temperature: 78,
        isExpired: true,
        merchant: "PlayStation Store",
        url: "https://www.dealabs.com/share-deal/3441527",
      }),
      post({
        id: "3446007",
        title:
          "Micro-Ondes Cecotec Proclean 5130 - 23L, Grill 1000W, Micro-Ondes 800W, 5 Niveaux de Puissance",
        price: 66.99,
        temperature: 345,
        merchant: "Amazon",
        url: "https://www.dealabs.com/share-deal/3446007",
      }),
    ]);
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input: any) => {
        const url = String(input);
        if (url.includes("3445887")) {
          return new Response("gone", { status: 410 });
        }
        if (url.includes("3438677")) {
          throw new Error("network down");
        }
        return new Response("", { status: 500 });
      });

    const summary = await service.checkAll();
    fetchMock.mockRestore();

    const read = (id: string) => fx.drafts.getById(id);
    const e = await read(expired.draft.id);
    expect(e.dealabsStatus).toBe("expired");
    expect(e.dealabsPostPrice).toBe(23.99);
    expect(e.dealabsStatusSource).toBe("profile");

    const h = await read(byHand.draft.id);
    expect(h.status).toBe("posted");
    expect(h.postedBy).toBe("manual");
    expect(h.dealabsStatus).toBe("live");
    expect(h.dealabsUrl).toBe("https://www.dealabs.com/share-deal/3446007");

    const g = await read(gone.draft.id);
    expect(g.dealabsStatus).toBe("deleted");
    expect(g.dealabsStatusSource).toBe("thread");
    // The banner of epic 29 shows it.
    expect(g.moderationStatus).toBe("deleted");

    const u = await read(unreadable.draft.id);
    expect(u.dealabsStatus ?? null).toBeNull();
    expect(u.dealabsCheckedAt ?? null).toBeNull();

    expect(summary.attached).toBe(1);
    expect(summary.unreadable).toBeGreaterThanOrEqual(1);
    expect(summary.line).toMatch(/^Dealabs : \d+ en ligne/);

    // Within the hour: not again.
    expect(await service.checkIfDue()).toBeUndefined();

    // Our expired post at 23,99 €: an evening slot may post it again at
    // the same price; the live hand-posted one is refused.
    const send = vi
      .spyOn((publisher as any).publisher, "publish")
      .mockResolvedValue({
        dealabsUrl: "https://www.dealabs.com/bons-plans/berserk-ps4-3449999",
      });
    vi.spyOn(
      (publisher as any).draftService,
      "maybeGenerateDraft",
    ).mockResolvedValue("generated");
    await expect(
      publisher.publishDeal(byHand.deal.id, "schedule"),
    ).rejects.toThrow(PublishRefusedError);
    const reposted = await publisher.publishDeal(expired.deal.id, "schedule");
    expect(reposted.status).toBe("posted");
    expect(reposted.dealabsStatus).toBe("live");
    expect(reposted.postedBy).toBe("agent");
    // The old post's link is not taken for a duplicate.
    expect(send.mock.calls[0][3]).toMatchObject({
      ignoreThreadUrl:
        "https://www.dealabs.com/bons-plans/berserk-and-the-band-of-the-hawk-ps4-playstation-store-3441527",
    });
    const history = JSON.parse(reposted.dealabsStatusHistory ?? "[]");
    expect(history.map((c: any) => c.to)).toEqual(["expired", "live"]);
    send.mockRestore();
  });

  test("expired post with a higher price today: not republished by the agents", async () => {
    const { deal } = await makeDeal(
      { title: "Clavier Glorious GMMK 3 HE", currentPrice: 179.99 },
      {
        status: "posted",
        dealabsUrl: "https://www.dealabs.com/bons-plans/clavier-3439444",
        dealabsStatus: "expired",
        dealabsPostPrice: 164.99,
      },
    );
    await expect(publisher.publishDeal(deal.id, "schedule")).rejects.toThrow(
      /au-dessus de notre post expiré/,
    );
  });
});
