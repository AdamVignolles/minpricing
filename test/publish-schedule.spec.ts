import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Alepha } from "alepha";
import { DateTimeProvider } from "alepha/datetime";
import { $repository } from "alepha/orm";
import { AlephaServer, ServerProvider } from "alepha/server";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";

import { dealEntity } from "../src/api/entities/Deal.ts";
import { publishScheduleEntity } from "../src/api/entities/PublishSchedule.ts";
import { ApiModule } from "../src/api/index.ts";
import {
  AutoPublishService,
  DealNotAvailableError,
} from "../src/api/services/AutoPublishService.ts";
import { DealabsDraftService } from "../src/api/services/DealabsDraftService.ts";
import { DealabsDuplicateError } from "../src/api/services/DealabsPublisherService.ts";
import { DealabsSessionService } from "../src/api/services/DealabsSessionService.ts";
import { DealPageCheckService } from "../src/api/services/DealPageCheckService.ts";
import {
  atParis,
  parisDay,
  parisTime,
  parisWeekday,
  randomTimes,
} from "../src/api/services/publishPlan.ts";
import { PublishScheduleService } from "../src/api/services/PublishScheduleService.ts";

const TOKEN = "c".repeat(64);
/** Wednesday 28 Oct 2026, 17:00 in Paris (winter time, UTC+1). */
const WEDNESDAY_17H = "2026-10-28T16:00:00.000Z";

describe("Paris times", () => {
  test("day, time and weekday in Paris, across DST", () => {
    const at = new Date("2026-10-28T22:30:00Z");
    expect(parisDay(at)).toBe("2026-10-28");
    expect(parisTime(at)).toBe("23:30");
    expect(parisWeekday(at)).toBe(3);
    expect(atParis("2026-10-28", "17:30").toISOString()).toBe(
      "2026-10-28T16:30:00.000Z",
    );
    expect(atParis("2026-07-01", "17:30").toISOString()).toBe(
      "2026-07-01T15:30:00.000Z",
    );
  });

  test("random times stay in the window, gaps respected", () => {
    const from = atParis("2026-10-28", "17:30");
    const to = atParis("2026-10-28", "21:30");
    for (let i = 0; i < 50; i++) {
      const times = randomTimes(5, from, to, 35);
      expect(times).toHaveLength(5);
      const ms = times.map((t) => t.getTime());
      expect(Math.min(...ms)).toBeGreaterThanOrEqual(from.getTime());
      expect(Math.max(...ms)).toBeLessThanOrEqual(to.getTime());
      const gaps = ms.slice(1).map((t, k) => t - ms[k]);
      expect(Math.min(...gaps)).toBeGreaterThanOrEqual(35 * 60_000);
    }
    // A short window holds fewer times.
    expect(
      randomTimes(5, from, new Date(from.getTime() + 60 * 60_000), 35),
    ).toHaveLength(2);
  });
});

class Fixtures {
  deals = $repository(dealEntity);
  entries = $repository(publishScheduleEntity);
}

describe("publishing plan", () => {
  let alepha: Alepha;
  let base: string;
  let dir: string;
  let schedule: PublishScheduleService;
  let publisher: AutoPublishService;
  let fx: Fixtures;
  let dealIds: string[];
  const clock = () => alepha.inject(DateTimeProvider) as any;
  const setNow = (iso: string) => {
    clock().ref = clock().of(iso);
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "publish-schedule-"));
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
    schedule = alepha.inject(PublishScheduleService);
    publisher = alepha.inject(AutoPublishService);
    fx = alepha.inject(Fixtures);
    dealIds = [];
    const make = async (title: string, categoryId: string) =>
      (
        await fx.deals.create({
          sourceId: "amazon",
          externalId: title,
          title,
          url: `https://example.com/${encodeURIComponent(title)}`,
          currentPrice: 100,
          categoryId,
          status: "active",
          firstSeenAt: new Date().toISOString(),
          lastSeenAt: new Date().toISOString(),
        } as any)
      ).id;
    dealIds.push(await make("Jeu A", "video-games"));
    dealIds.push(await make("Jeu B", "video-games"));
    dealIds.push(await make("PC portable", "computing"));
    dealIds.push(await make("Casque", "audio"));
    vi.spyOn(alepha.inject(DealabsSessionService), "status").mockReturnValue({
      available: true,
      connected: true,
    } as any);
    vi.spyOn(
      alepha.inject(DealabsDraftService),
      "ensureDraftForDeal",
    ).mockResolvedValue(undefined as any);
  }, 30_000);

  afterAll(async () => {
    vi.restoreAllMocks();
    await alepha?.stop();
    delete process.env.APP_FILES_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    setNow(WEDNESDAY_17H);
    await fx.entries.deleteMany({});
    rmSync(join(dir, "data"), { recursive: true, force: true });
  });

  const call = (method: string, path: string, body?: unknown) =>
    fetch(`${base}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${TOKEN}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const ranked = () => dealIds.map((dealId) => ({ dealId }));
  const ledger = () => {
    const file = join(dir, "data", "agents", "ledger.jsonl");
    return existsSync(file)
      ? readFileSync(file, "utf8")
          .trim()
          .split("\n")
          .map((l) => JSON.parse(l))
      : [];
  };

  test("an agent sets the plan: 2 to 5 times in the window, files written", async () => {
    const res = await call("PUT", "/agent/schedule", {
      ranked: [...ranked(), { dealId: "unknown" }],
      agent: "deals-select",
      reason: "test",
    });
    expect(res.status).toBe(200);
    const plan = (await res.json()) as any;
    expect(plan.date).toBe("2026-10-28");
    expect(plan.dropped).toEqual(["unknown"]);
    expect(plan.entries.length).toBeGreaterThanOrEqual(2);
    expect(plan.entries.length).toBeLessThanOrEqual(4); // 4 active deals
    for (const e of plan.entries) {
      const t = parisTime(new Date(e.plannedAt));
      expect(t >= "17:30" && t <= "21:30").toBe(true);
    }
    const planFile = JSON.parse(
      readFileSync(join(dir, "data", "agents", "plan-2026-10-28.json"), "utf8"),
    );
    expect(planFile.times).toHaveLength(plan.entries.length);
    expect(
      existsSync(join(dir, "data", "agents", "queue-2026-10-28.json")),
    ).toBe(true);

    // A new plan replaces the planned entries.
    await call("PUT", "/agent/schedule", {
      ranked: ranked(),
      agent: "deals-select",
    });
    const list = (await (await call("GET", "/agent/schedule")).json()) as any;
    expect(
      list.entries.filter((e: any) => e.status === "planned").length,
    ).toBeGreaterThan(0);
    expect(
      list.entries.filter((e: any) => e.status === "cancelled"),
    ).toHaveLength(plan.entries.length);
  });

  test("explicit times outside the window or on a weekend are refused", async () => {
    expect(
      (
        await call("PUT", "/agent/schedule", {
          ranked: ranked(),
          times: ["22:00"],
          agent: "t",
        })
      ).status,
    ).toBe(422);
    setNow("2026-10-31T16:00:00.000Z"); // Saturday
    expect(
      (await call("PUT", "/agent/schedule", { ranked: ranked(), agent: "t" }))
        .status,
    ).toBe(409);
  });

  test("the token can't publish by itself: the console's publish button stays admin", async () => {
    expect(
      (await call("POST", `/deals/${dealIds[0]}/draft/auto-publish`)).status,
    ).toBe(401);
  });

  test("due entry: duplicate moves on, success stops, category cap honoured", async () => {
    const publish = vi
      .spyOn(publisher, "publishDeal")
      .mockImplementation(async (id: string) => {
        if (id === dealIds[0]) {
          throw new DealabsDuplicateError(
            "déjà sur Dealabs",
            "https://dealabs/x",
          );
        }
        return {
          dealabsUrl: `https://www.dealabs.com/bons-plans/${id}`,
        } as any;
      });
    await call("PUT", "/agent/schedule", {
      ranked: ranked(),
      times: ["17:40", "18:30"],
      agent: "deals-select",
    });
    expect(await schedule.runDue()).toEqual([]); // nothing due at 17:00

    setNow("2026-10-28T16:41:00.000Z"); // 17:41
    const [first] = await schedule.runDue();
    expect(first.status).toBe("done");
    expect(first.result).toBe("success");
    expect(first.dealId).toBe(dealIds[1]);
    expect(ledger().map((l) => l.result)).toEqual(["duplicate", "success"]);

    // Games are capped at 1 a day: the next slot skips Jeu A/B and takes the PC.
    setNow("2026-10-28T17:31:00.000Z"); // 18:31
    const [second] = await schedule.runDue();
    expect(second.dealId).toBe(dealIds[2]);
    expect(publish).toHaveBeenCalledTimes(3);
    const published = JSON.parse(
      readFileSync(
        join(dir, "data", "agents", "published-2026-10-28.json"),
        "utf8",
      ),
    );
    expect(published.results).toHaveLength(3);
    publish.mockRestore();
  });

  test("unavailable pages, stale entries and the session are handled", async () => {
    const publish = vi
      .spyOn(publisher, "publishDeal")
      .mockRejectedValue(new DealNotAvailableError("plus en stock"));
    await call("PUT", "/agent/schedule", {
      ranked: ranked(),
      times: ["17:40", "18:30"],
      agent: "deals-select",
    });
    setNow("2026-10-28T16:41:00.000Z");
    const [entry] = await schedule.runDue();
    expect(entry.status).toBe("skipped");
    expect(entry.result).toBe("unavailable");
    expect(publish).toHaveBeenCalledTimes(4); // MAX_TRIES_PER_SLOT

    setNow("2026-10-28T21:00:00.000Z"); // 22:00: 18:30 is 3h30 late
    const [late] = await schedule.runDue();
    expect(late.status).toBe("skipped");
    expect(late.note).toContain("trop tard");
    expect(publish).toHaveBeenCalledTimes(4);
    publish.mockRestore();
  });

  test("dry run: page check only, no publish, no ledger", async () => {
    const publish = vi.spyOn(publisher, "publishDeal");
    const check = vi
      .spyOn(alepha.inject(DealPageCheckService), "check")
      .mockResolvedValue({ ok: true } as any);
    const res = await call("PUT", "/agent/schedule", {
      ranked: ranked(),
      now: true,
      dryRun: true,
      agent: "health-check",
    });
    expect(res.status).toBe(200);
    setNow("2026-10-28T16:10:00.000Z");
    const ran = await schedule.runDue();
    expect(ran.length).toBeGreaterThan(0);
    for (const e of ran) expect(e.result).toBe("dry-run");
    expect(publish).not.toHaveBeenCalled();
    expect(ledger()).toEqual([]);
    expect(
      existsSync(join(dir, "data", "agents", "plan-2026-10-28.json")),
    ).toBe(false);
    publish.mockRestore();
    check.mockRestore();
  });

  test("cancel and move a planned entry", async () => {
    const plan = (await (
      await call("PUT", "/agent/schedule", {
        ranked: ranked(),
        times: ["17:40", "18:30"],
        agent: "deals-select",
      })
    ).json()) as any;
    const [a, b] = plan.entries;
    const moved = (await (
      await call("PATCH", `/agent/schedule/${a.id}`, { time: "19:15" })
    ).json()) as any;
    expect(parisTime(new Date(moved.plannedAt))).toBe("19:15");
    expect((await call("POST", `/agent/schedule/${b.id}/cancel`)).status).toBe(
      200,
    );
    expect((await call("POST", `/agent/schedule/${b.id}/cancel`)).status).toBe(
      409,
    );
    expect(
      (await call("PATCH", `/agent/schedule/${a.id}`, { time: "16:00" }))
        .status,
    ).toBe(422);
  });
});
