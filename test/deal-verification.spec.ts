import { Alepha } from "alepha";
import { describe, expect, test, vi } from "vitest";

import { ApiModule } from "../src/api/index.ts";
import { DealabsHistoryService } from "../src/api/services/DealabsHistoryService.ts";
import type { DealPageVerdict } from "../src/api/services/dealPageCheck.ts";
import { DealPageCheckService } from "../src/api/services/DealPageCheckService.ts";
import {
  blocksPublish,
  isFresh,
  removesDeal,
  verdictFromPageCheck,
} from "../src/api/services/dealVerification.ts";
import { DealVerificationService } from "../src/api/services/DealVerificationService.ts";

describe("verdict mapping", () => {
  test("page failures keep their kind, ok maps to ok", () => {
    expect(verdictFromPageCheck({ ok: true })).toEqual({ verdict: "ok" });
    expect(
      verdictFromPageCheck({
        ok: false,
        reason: "x",
        kind: "price-changed",
        observedPrice: 12,
      }),
    ).toEqual({ verdict: "price-changed", reason: "x", observedPrice: 12 });
  });

  test("only positive evidence removes a deal; unknown never does", () => {
    expect(removesDeal("gone")).toBe(true);
    expect(removesDeal("out-of-stock")).toBe(true);
    for (const verdict of [
      "ok",
      "price-changed",
      "already-on-dealabs",
      "blocked",
      "unreachable",
    ] as const) {
      expect(removesDeal(verdict)).toBe(false);
    }
    expect(blocksPublish("ok")).toBe(false);
    expect(blocksPublish("blocked")).toBe(true);
  });

  test("freshness window is 10 minutes", () => {
    const now = new Date("2026-10-28T10:00:00Z");
    expect(isFresh("2026-10-28T09:55:00Z", now)).toBe(true);
    expect(isFresh("2026-10-28T09:40:00Z", now)).toBe(false);
    expect(isFresh(undefined, now)).toBe(false);
  });
});

describe("DealVerificationService", () => {
  async function setup(check: DealPageVerdict) {
    const alepha = Alepha.create({
      env: { ADMIN_USERNAME: "a", ADMIN_PASSWORD: "a" },
    }).with(ApiModule);
    await alepha.start();
    const service = alepha.inject(DealVerificationService);
    const pageCheck = alepha.inject(DealPageCheckService);
    const history = alepha.inject(DealabsHistoryService);
    const checkSpy = vi.spyOn(pageCheck, "check").mockResolvedValue(check);
    vi.spyOn(history, "findLiveDuplicate").mockResolvedValue(undefined);
    const internals = service as unknown as {
      deals: {
        create(data: object): Promise<{ id: string }>;
        getById(id: string): Promise<Record<string, unknown>>;
      };
      drafts: {
        create(data: object): Promise<{ id: string }>;
        getById(id: string): Promise<Record<string, unknown>>;
      };
    };
    const now = new Date().toISOString();
    const deal = await internals.deals.create({
      sourceId: "amazon",
      externalId: "B000",
      title: "Produit test",
      url: "https://example.com/p",
      currentPrice: 10,
      firstSeenAt: now,
      lastSeenAt: now,
    });
    const draft = await internals.drafts.create({
      dealId: deal.id,
      title: "t",
      body: "b",
      generatedAt: now,
    });
    return { alepha, service, internals, deal, draft, checkSpy };
  }

  test("gone expires the deal and sets the draft aside; ok brings it back", async () => {
    const ctx = await setup({
      ok: false,
      reason: "page introuvable chez le marchand (404)",
      kind: "gone",
    });
    const result = await ctx.service.verify(ctx.deal.id);
    expect(result.verdict).toBe("gone");
    expect(await ctx.internals.deals.getById(ctx.deal.id)).toMatchObject({
      status: "expired",
      verifyVerdict: "gone",
    });
    expect(await ctx.internals.drafts.getById(ctx.draft.id)).toMatchObject({
      status: "discarded",
    });

    ctx.checkSpy.mockResolvedValue({ ok: true });
    await ctx.service.verify(ctx.deal.id, { force: true });
    expect(await ctx.internals.deals.getById(ctx.deal.id)).toMatchObject({
      status: "active",
      verifyVerdict: "ok",
    });
    expect(await ctx.internals.drafts.getById(ctx.draft.id)).toMatchObject({
      status: "draft",
    });
    await ctx.alepha.stop();
  });

  test("blocked and price-changed keep the deal; result is cached", async () => {
    const ctx = await setup({
      ok: false,
      reason: "prix introuvable",
      kind: "blocked",
    });
    await ctx.service.verify(ctx.deal.id);
    await ctx.service.verify(ctx.deal.id);
    expect(ctx.checkSpy).toHaveBeenCalledTimes(1);
    expect(await ctx.internals.deals.getById(ctx.deal.id)).toMatchObject({
      status: "active",
      verifyVerdict: "blocked",
    });
    expect(await ctx.internals.drafts.getById(ctx.draft.id)).toMatchObject({
      status: "draft",
    });
    await ctx.alepha.stop();
  });
});
