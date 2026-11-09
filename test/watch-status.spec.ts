import { describe, expect, test } from "vitest";

import { linkDue } from "../src/api/services/WatchedLinkService.ts";
import {
  dealabsStanding,
  watchStatusOf,
  watchUpdate,
} from "../src/api/services/watchStatus.ts";

const now = new Date("2026-11-09T12:00:00Z");
const hoursAgo = (n: number) =>
  new Date(now.getTime() - n * 3_600_000).toISOString();
const drop = {
  drop: {
    reference: "amazon-30d-low" as const,
    referencePrice: 99.9,
    percent: 22,
    saving: 22,
    days: 4,
  },
};
const noDrop = { reason: "above-30d-low" as const, days: 4 };

describe("watchStatusOf (epic 33)", () => {
  test("precedence: our live post, someone else's, a real drop, else waiting", () => {
    const mine = { url: "u", price: 70, temperature: 120, mine: true };
    const others = { url: "u", price: 75, temperature: 40, mine: false };
    expect(watchStatusOf({ onDealabs: mine, drop }).status).toBe("published");
    expect(watchStatusOf({ onDealabs: others, drop }).status).toBe(
      "on_dealabs",
    );
    expect(watchStatusOf({ drop }).status).toBe("price_drop");
    expect(watchStatusOf({ drop: noDrop })).toEqual({
      status: "waiting",
      reason: "Pas sous le prix le plus bas des 30 derniers jours",
    });
  });

  test("our post expired, hidden or deleted: back in the running", () => {
    for (const status of ["expired", "hidden", "deleted"] as const) {
      const onDealabs = {
        url: "u",
        price: 70,
        temperature: 9,
        mine: true,
        status,
      };
      expect(watchStatusOf({ onDealabs, drop }).status).toBe("price_drop");
      expect(watchStatusOf({ onDealabs, drop: noDrop }).reason).toMatch(
        /^Votre deal Dealabs n'est plus en ligne/,
      );
    }
  });
});

describe("dealabsStanding", () => {
  const deal = (history: unknown[]) => ({
    title: "Casque Sony WH-1000XM5",
    currentPrice: 249,
    dealabsHistory: JSON.stringify(history),
  });
  const thread = (isExpired: boolean) => ({
    title: "Casque Sony WH-1000XM5",
    price: 239,
    publishedAt: hoursAgo(48),
    temperature: 150,
    isHot: true,
    isExpired,
    url: "https://www.dealabs.com/bons-plans/casque-1",
  });

  test("someone else's live post greys it; once expired, it doesn't", () => {
    expect(dealabsStanding(deal([thread(false)]), undefined, [])).toMatchObject(
      { mine: false },
    );
    expect(dealabsStanding(deal([thread(true)]), undefined, [])).toBe(
      undefined,
    );
  });

  test("our posted draft: its checked status", () => {
    expect(
      dealabsStanding(
        deal([]),
        { status: "posted", dealabsStatus: "expired", dealabsUrl: "u" },
        [],
      ),
    ).toMatchObject({ mine: true, status: "expired" });
  });
});

describe("watchUpdate", () => {
  test("nothing changed: nothing written", () => {
    expect(
      watchUpdate(
        { watchStatus: "waiting", watchReason: "x" },
        { status: "waiting", reason: "x" },
        now.toISOString(),
      ),
    ).toBeUndefined();
  });

  test("same status, new reason: reason only, no history entry", () => {
    expect(
      watchUpdate(
        { watchStatus: "waiting", watchReason: "x" },
        { status: "waiting", reason: "y" },
        now.toISOString(),
      ),
    ).toEqual({ watchStatus: "waiting", watchReason: "y" });
  });

  test("a new status is dated and goes to the history", () => {
    const patch = watchUpdate(
      { watchStatus: "waiting", watchHistory: "[]" },
      { status: "price_drop", reason: "−22 %" },
      now.toISOString(),
    );
    expect(patch?.watchStatusAt).toBe(now.toISOString());
    expect(JSON.parse(patch?.watchHistory ?? "[]")).toEqual([
      {
        at: now.toISOString(),
        from: "waiting",
        to: "price_drop",
        reason: "−22 %",
      },
    ]);
  });
});

describe("linkDue", () => {
  const link = (over: Record<string, unknown>) => ({
    status: "ok" as const,
    watchUntil: hoursAgo(24),
    lastCheckedAt: hoursAgo(2),
    watchStatus: "waiting" as const,
    ...over,
  });

  test("hourly while new, never read, or in « Baisse de prix »", () => {
    expect(linkDue(link({ watchUntil: hoursAgo(-24) }) as any, now)).toBe(true);
    expect(linkDue(link({ lastCheckedAt: undefined }) as any, now)).toBe(true);
    expect(linkDue(link({ watchStatus: "price_drop" }) as any, now)).toBe(true);
  });

  test("then once a day; stopped or removed never", () => {
    expect(linkDue(link({}) as any, now)).toBe(false);
    expect(linkDue(link({ lastCheckedAt: hoursAgo(23) }) as any, now)).toBe(
      true,
    );
    expect(linkDue(link({ status: "ended" }) as any, now)).toBe(false);
    expect(linkDue(link({ status: "removed" }) as any, now)).toBe(false);
  });
});
