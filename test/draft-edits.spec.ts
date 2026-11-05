import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Alepha } from "alepha";
import { DateTimeProvider } from "alepha/datetime";
import { $repository } from "alepha/orm";
import { AlephaServer, ServerProvider } from "alepha/server";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

import { agentWriteEntity } from "../src/api/entities/AgentWrite.ts";
import { dealEntity } from "../src/api/entities/Deal.ts";
import { dealabsDraftEntity } from "../src/api/entities/DealabsDraft.ts";
import { ApiModule } from "../src/api/index.ts";
import {
  checkAgentDescription,
  DealabsDraftService,
} from "../src/api/services/DealabsDraftService.ts";
import { DealabsSessionService } from "../src/api/services/DealabsSessionService.ts";
import { DESCRIPTION_TEMPLATE } from "../src/api/services/dealDescription.ts";
import {
  descriptionHtml,
  descriptionVisibleText,
} from "../src/api/services/descriptionHtml.ts";
import { MyDealabsPostsService } from "../src/api/services/MyDealabsPostsService.ts";

describe("descriptionHtml", () => {
  test("labels before a list in bold, items, paragraphs, escaped", () => {
    expect(
      descriptionHtml(
        "Jeu sur Steam.\n\nEn bref :\n- Un & deux\n- <b>trois</b>\n\nLigne 1\nLigne 2",
      ),
    ).toBe(
      "<p>Jeu sur Steam.</p><p><strong>En bref :</strong></p><ul><li>Un &amp; deux</li><li>&lt;b&gt;trois&lt;/b&gt;</li></ul><p>Ligne 1<br>Ligne 2</p>",
    );
  });

  test("« **gras** », and a « : » line with no list stays a paragraph", () => {
    expect(descriptionHtml("Prix **imbattable** ici :\nfin")).toBe(
      "<p>Prix <strong>imbattable</strong> ici :<br>fin</p>",
    );
  });

  test("visible text drops the list markers and the stars", () => {
    expect(descriptionVisibleText("En bref :\n- Un\n**Deux**")).toBe(
      "En bref :\nUn\nDeux",
    );
  });
});

describe("checkAgentDescription", () => {
  const ok =
    "Caractéristiques :\n- Mémoire DDR5 6000 MHz CL36\n- Dissipateur en aluminium noir\n- Profils Intel XMP 3.0 et AMD Expo";
  test("a factual text passes", () => {
    expect(checkAgentDescription(ok)).toBeUndefined();
  });
  test.each([
    ["court", /trop courte/],
    [`${ok}\n- ${"x".repeat(2200)}`, /trop longue/],
    [`${ok}\n- Repéré par DealRadar`, /DealRadar/],
    [`${ok}\n- Score 87/100`, /note/],
    [`${ok}\n- Seulement 49,99 € au lieu de 80 €`, /prix/],
    [`${ok}\n- <b>gras</b>`, /HTML/],
  ])("refused: %s", (text, reason) => {
    expect(checkAgentDescription(text)).toMatch(reason);
  });
});

const TOKEN = "d".repeat(64);
/** Wednesday 28 Oct 2026, 17:00 in Paris: a publishing day. */
const WEDNESDAY_17H = "2026-10-28T16:00:00.000Z";

class Fixtures {
  deals = $repository(dealEntity);
  drafts = $repository(dealabsDraftEntity);
  writes = $repository(agentWriteEntity);
}

describe("draft edits (#131)", () => {
  let alepha: Alepha;
  let dir: string;
  let base: string;
  let fx: Fixtures;
  let service: DealabsDraftService;
  let dealId: string;
  const AGENT_TEXT =
    "Le jeu :\n- Construction et rénovation de maisons, en solo\n- Textes en français\n\nÀ savoir :\n- Clé Steam livrée sur le compte";

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "draft-edits-"));
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
    service = alepha.inject(DealabsDraftService);
    const now = alepha.inject(DateTimeProvider).nowISOString();
    dealId = (
      await fx.deals.create({
        sourceId: "steam",
        externalId: "613100",
        title: "House Flipper",
        url: "https://store.steampowered.com/app/613100",
        currentPrice: 9.99,
        listPrice: 24.5,
        listPriceKind: "regular",
        sellerName: "Steam",
        soldByMerchant: true,
        description: "- Rénovez des maisons\n- Revendez-les",
        status: "active",
        firstSeenAt: now,
        lastSeenAt: now,
      } as any)
    ).id;
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

  const draft = () => fx.drafts.findOne({ where: { dealId: { eq: dealId } } });

  test("generated: Dealabs-style title, price lines, template version", async () => {
    expect(
      await service.maybeGenerateDraft(await fx.deals.getById(dealId)),
    ).toBe("generated");
    const d = await draft();
    expect(d?.title).toBe("House Flipper sur PC (Dématérialisé - Steam)");
    expect(d?.description).toMatch(/^Repères de prix :\n- Prix habituel/);
    expect(d?.templateVersion).toBe(DESCRIPTION_TEMPLATE);
    expect(d?.editedAt).toBeFalsy();
  });

  test("an agent's text is kept, with today's price lines on top", async () => {
    const result = await service.editByAgent(
      dealId,
      AGENT_TEXT,
      "deals-select",
    );
    expect(result.ok).toBe(true);
    let d = await draft();
    expect(d?.editedBy).toBe("agent:deals-select");
    expect(d?.description).toMatch(
      /^Repères de prix :\n- Prix habituel.*\n\nLe jeu :/s,
    );
    // A collection pass keeps the agent's words, rebuilds the price lines.
    expect(
      await service.maybeGenerateDraft(await fx.deals.getById(dealId)),
    ).toBe("agent-edit");
    d = await draft();
    expect(d?.description?.match(/Repères de prix/g)).toHaveLength(1);
    expect(d?.description).toContain("Clé Steam livrée sur le compte");
  });

  test("the owner's edit wins and is never regenerated", async () => {
    await service.editByOwner(dealId, {
      title: "Mon titre",
      description: "Mon texte à moi, sans liste.",
    });
    expect(
      await service.maybeGenerateDraft(await fx.deals.getById(dealId)),
    ).toBe("owner-edit");
    const d = await draft();
    expect(d?.title).toBe("Mon titre");
    expect(d?.description).toBe("Mon texte à moi, sans liste.");
    expect(d?.editedBy).toBe("owner");
    const agent = await service.editByAgent(dealId, AGENT_TEXT, "deals-select");
    expect(agent).toEqual({
      ok: false,
      reason: "description modifiée par le propriétaire",
    });
  });

  test("« Régénérer » goes back to the generated text", async () => {
    const d = await service.regenerate(dealId);
    expect(d?.editedAt).toBeFalsy();
    expect(d?.editedBy).toBeFalsy();
    expect(d?.title).toBe("House Flipper sur PC (Dématérialisé - Steam)");
    expect(d?.description).toMatch(/^Repères de prix/);
  });

  test("the draft endpoint still answers after a regenerate (cleared columns)", async () => {
    const res = await fetch(`${base}/deals/${dealId}/draft`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.title).toBe("House Flipper sur PC (Dématérialisé - Steam)");
  });

  test("PUT /agent/schedule applies a description and audits it", async () => {
    const clock = alepha.inject(DateTimeProvider) as any;
    const saved = clock.ref;
    clock.ref = clock.of(WEDNESDAY_17H);
    try {
      const res = await fetch(`${base}/agent/schedule`, {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${TOKEN}`,
        },
        body: JSON.stringify({
          ranked: [{ dealId, description: AGENT_TEXT }],
          agent: "deals-select",
          dryRun: true,
        }),
      });
      expect(res.status).toBe(200);
      const plan = (await res.json()) as any;
      // A dry run only checks.
      expect(plan.descriptions).toEqual([{ dealId, accepted: true }]);
      expect((await draft())?.editedBy).toBeFalsy();

      const real = await fetch(`${base}/agent/schedule`, {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${TOKEN}`,
        },
        body: JSON.stringify({
          ranked: [{ dealId, description: AGENT_TEXT }],
          agent: "deals-select",
        }),
      });
      expect(real.status).toBe(200);
      expect(((await real.json()) as any).descriptions).toEqual([
        { dealId, accepted: true },
      ]);
      expect((await draft())?.editedBy).toBe("agent:deals-select");
      const audit = await fx.writes.findMany({
        where: { kind: { eq: "description" } },
      });
      expect(audit).toHaveLength(1);
      expect(audit[0].target).toBe(`draft-${dealId}`);
    } finally {
      clock.ref = saved;
    }
  });

  test("roll-out: outdated drafts of visible deals rewritten, edited ones kept", async () => {
    const now = alepha.inject(DateTimeProvider).nowISOString();
    const make = async (externalId: string, score: number) =>
      (
        await fx.deals.create({
          sourceId: "steam",
          externalId,
          title: `Jeu ${externalId}`,
          url: `https://store.steampowered.com/app/${externalId}`,
          currentPrice: 5,
          listPrice: 20,
          listPriceKind: "regular",
          description: "- Un point",
          status: "active",
          score,
          firstSeenAt: now,
          lastSeenAt: now,
        } as any)
      ).id;
    const visible = await make("1", 60);
    const hidden = await make("2", 20);
    const edited = await make("3", 60);
    for (const id of [visible, hidden, edited]) {
      await fx.drafts.create({
        dealId: id,
        title: "ancien",
        body: "ancien",
        description: "ancien",
        generatedAt: now,
        ...(id === edited ? { editedAt: now, editedBy: "owner" } : {}),
      });
    }
    expect(await service.rollOutTemplate()).toBeGreaterThanOrEqual(1);
    const of = (id: string) =>
      fx.drafts.findOne({ where: { dealId: { eq: id } } });
    expect((await of(visible))?.templateVersion).toBe(DESCRIPTION_TEMPLATE);
    expect((await of(visible))?.title).toBe(
      "Jeu 1 sur PC (Dématérialisé - Steam)",
    );
    expect((await of(hidden))?.title).toBe("ancien");
    expect((await of(edited))?.title).toBe("ancien");
  });

  test("GET /agent/descriptions joins our posts' temperatures", async () => {
    const d = await draft();
    await fx.drafts.updateById(d!.id, {
      status: "posted",
      dealabsUrl: "https://www.dealabs.com/bons-plans/house-flipper-3450001",
      verifiedAt: alepha.inject(DateTimeProvider).nowISOString(),
    });
    vi.spyOn(
      alepha.inject(MyDealabsPostsService),
      "postsNow",
    ).mockResolvedValue([
      {
        id: "3450001",
        title: "House Flipper",
        price: 1.96,
        temperature: 142,
        isHot: true,
        isExpired: false,
        publishedAt: "2026-11-05T18:00:00.000Z",
        url: "https://www.dealabs.com/bons-plans/house-flipper-3450001",
      },
    ]);
    const res = await fetch(`${base}/agent/descriptions?days=30`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const { posts } = (await res.json()) as any;
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({
      dealId,
      templateVersion: DESCRIPTION_TEMPLATE,
      editedBy: "agent:deals-select",
      temperature: 142,
      isHot: true,
    });
  });
});
