import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Alepha } from "alepha";
import { AlephaServer, ServerProvider } from "alepha/server";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { ApiModule } from "../src/api/index.ts";
import {
  checkCollection,
  checkDesirability,
  checkPublishRules,
} from "../src/api/services/agentConfig.ts";
import { insertChangelogEntry } from "../src/api/services/AgentFilesService.ts";

/**
 * The agents' write API: the agent token opens `/agent/*` and the
 * console's reads, never an admin write; configs move only inside their
 * own bounds; file names can't escape `data/agents/`.
 */
const TOKEN = "a".repeat(64);
const rules = () =>
  JSON.parse(readFileSync("config/publish-rules.json", "utf8"));
const desirability = () =>
  JSON.parse(readFileSync("config/desirability.json", "utf8"));
const collection = () =>
  JSON.parse(readFileSync("config/collection.json", "utf8"));

describe("config bounds", () => {
  test("publish rules: inside the bounds passes, outside is refused", () => {
    const next = rules();
    next.minScore = 70;
    next.sourceAdjust.cdiscount = 8;
    const ok = checkPublishRules(rules(), next);
    expect(ok.errors).toEqual([]);
    expect(ok.changes).toContain("minScore: 65 → 70");

    next.minScore = 95;
    next.categoryAdjust.computing = 40;
    expect(checkPublishRules(rules(), next).errors).toHaveLength(2);
  });

  test("publish rules: bounds, publish days and Adam's choices are locked", () => {
    const widened = rules();
    widened.bounds.minScore = [0, 100];
    expect(checkPublishRules(rules(), widened).errors[0]).toContain("bounds");

    const days = rules();
    days.publishDays = [0, 1, 2, 3, 4, 5, 6];
    expect(checkPublishRules(rules(), days).errors[0]).toContain("publishDays");

    const games = rules();
    games.categoryAdjust["video-games"] = 0; // Adam: ≤ -10
    games.sourceAdjust.amazon = 0; // Adam: ≥ 5
    expect(checkPublishRules(rules(), games).errors).toHaveLength(2);
  });

  test("desirability: one step per key, no deletion, few keys at once", () => {
    const next = desirability();
    next.brands.Ryobi += 0.2;
    expect(checkDesirability(desirability(), next).errors).toEqual([]);

    next.brands.Ryobi += 0.2;
    expect(checkDesirability(desirability(), next).errors[0]).toContain(
      "pas maximal",
    );

    const deleted = desirability();
    delete deleted.brands.Bosch;
    expect(checkDesirability(desirability(), deleted).errors[0]).toContain(
      "supprimé",
    );

    const many = desirability();
    for (const key of Object.keys(many.brands).slice(0, 7)) {
      many.brands[key] = Math.round((many.brands[key] + 0.1) * 10) / 10;
    }
    expect(checkDesirability(desirability(), many).errors.join(" ")).toContain(
      "max 6",
    );

    const newKey = desirability();
    newKey.brands.Dreame = 0.2;
    expect(checkDesirability(desirability(), newKey).errors).toEqual([]);
    newKey.brands.Dreame = 0.5;
    expect(checkDesirability(desirability(), newKey).errors).toHaveLength(1);
  });

  test("collection: only toggles and clamped numbers", () => {
    const next = collection();
    next.amazon.limit = 200;
    next.amazon.extraPages.kitchen.enabled = false;
    next.sources.steam.everyHours = 12;
    expect(checkCollection(collection(), next).errors).toEqual([]);

    const url = collection();
    url.amazon.extraPages.kitchen.url = "https://evil.example";
    const added = collection();
    added.cdiscount.extraPages.new = { url: "https://x", enabled: true };
    const lockedOff = collection();
    lockedOff.sources.amazon.enabled = false;
    const hours = collection();
    hours.sources.steam.everyHours = 48;
    const limit = collection();
    limit.amazon.limit = 1000;
    for (const bad of [url, added, lockedOff, hours, limit]) {
      expect(checkCollection(collection(), bad).errors.length).toBeGreaterThan(
        0,
      );
    }
  });

  test("changelog entries go on top, under the header", () => {
    const doc = "# Log\n\nIntro.\n\n## v2\n\n- b\n\n## v1\n\n- a\n";
    expect(insertChangelogEntry(doc, "## v3\n\n- c")).toBe(
      "# Log\n\nIntro.\n\n## v3\n\n- c\n\n## v2\n\n- b\n\n## v1\n\n- a\n",
    );
  });
});

describe("agent API", () => {
  let alepha: Alepha;
  let base: string;
  let dir: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "agent-api-"));
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
      .with(ApiModule);
    await alepha.start();
    base = `${alepha.inject(ServerProvider).hostname}/api`;
  }, 30_000);

  afterAll(async () => {
    await alepha?.stop();
    delete process.env.APP_FILES_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  const call = (
    method: string,
    path: string,
    body?: unknown,
    token: string | undefined = TOKEN,
  ) =>
    fetch(`${base}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  test("no token, a wrong one, or a short one: 401", async () => {
    expect(
      (await call("GET", "/agent/config/publish-rules", undefined, "")).status,
    ).toBe(401);
    expect(
      (
        await call(
          "GET",
          "/agent/config/publish-rules",
          undefined,
          "b".repeat(64),
        )
      ).status,
    ).toBe(401);
    expect(
      (await call("GET", "/agents/overview", undefined, "a".repeat(10))).status,
    ).toBe(401);
  });

  test("the token reads the console's GETs but never reaches an admin write", async () => {
    expect((await call("GET", "/agents/overview")).status).toBe(200);
    expect((await call("POST", "/admin/collect")).status).toBe(401);
  });

  test("a config inside its bounds is written, with backup, changelog and audit", async () => {
    const res = await call("GET", "/agent/config/publish-rules");
    expect(res.status).toBe(200);
    const current = JSON.parse(((await res.json()) as any).content);
    current.minScore = 68;
    const put = await call("PUT", "/agent/config/publish-rules", {
      content: JSON.stringify(current, null, 2),
      agent: "deals-weekly",
      reason: "test",
      changelog: "## v4 — test — deals-weekly\n\n- minScore 65 → 68",
    });
    expect(put.status).toBe(200);
    expect(((await put.json()) as any).changes).toContain("minScore: 65 → 68");
    expect(
      JSON.parse(
        readFileSync(join(dir, "config", "publish-rules.json"), "utf8"),
      ).minScore,
    ).toBe(68);
    expect(existsSync(join(dir, "config", "publish-rules.previous.json"))).toBe(
      true,
    );
    expect(
      readFileSync(join(dir, "docs", "publish-rules-changelog.md"), "utf8"),
    ).toContain("minScore 65 → 68");

    const changes = (await (
      await call("GET", "/agent/changes")
    ).json()) as any[];
    expect(changes[0]).toMatchObject({
      agent: "deals-weekly",
      kind: "config",
      target: "publish-rules",
    });
    expect(changes[0].summary).toContain("minScore");
  });

  test("a config out of bounds is refused and the file is untouched", async () => {
    const before = readFileSync(
      join(dir, "config", "desirability.json"),
      "utf8",
    );
    const next = JSON.parse(before);
    next.bounds = [-5, 5];
    const put = await call("PUT", "/agent/config/desirability", {
      content: JSON.stringify(next),
      agent: "deals-debrief",
    });
    expect(put.status).toBe(422);
    expect(readFileSync(join(dir, "config", "desirability.json"), "utf8")).toBe(
      before,
    );
    expect(
      (
        await call("PUT", "/agent/config/secrets", {
          content: "{}",
          agent: "x",
        })
      ).status,
    ).toBe(404);
  });

  test("the dataset serves the rows tune-stats and sources-review query", async () => {
    expect((await call("GET", "/agent/dataset", undefined, "")).status).toBe(
      401,
    );
    const res = await call("GET", "/agent/dataset?days=30");
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(Array.isArray(body.deals)).toBe(true);
    expect(Array.isArray(body.sources)).toBe(true);
    expect(typeof body.collectionRuns).toBe("string");
    for (const deal of body.deals) {
      expect(Object.keys(deal).sort()).toEqual([
        "category_id",
        "dealabs_history",
        "hot_chance",
        "last_seen_at",
        "score",
        "source_id",
        "status",
      ]);
    }
  });

  test("file names can't leave data/agents", async () => {
    for (const name of [
      "..%2F..%2Fconfig%2Fpublish-rules.json",
      "ledger.jsonl",
      "report-2026-10-28.js",
      "evil-2026-10-28.json",
    ]) {
      const res = await call("PUT", `/agent/data/${name}`, {
        content: "{}",
        agent: "x",
      });
      expect(res.status, name).toBeGreaterThanOrEqual(400);
    }
    expect(
      (
        await call("PUT", "/agent/reports/..%2Fx", {
          markdown: "#",
          agent: "x",
        })
      ).status,
    ).toBe(400);

    const ok = await call("PUT", "/agent/data/report-2026-10-28.json", {
      content: '{"ok":true}',
      agent: "routine",
    });
    expect(ok.status).toBe(200);
    expect(
      readFileSync(
        join(dir, "data", "agents", "report-2026-10-28.json"),
        "utf8",
      ),
    ).toBe('{"ok":true}');
    const back = (await (
      await call("GET", "/agent/data/report-2026-10-28.json")
    ).json()) as any;
    expect(back.content).toBe('{"ok":true}');

    const report = await call("PUT", "/agent/reports/weekly-2026-10-28", {
      markdown: "# Revue",
      agent: "deals-weekly",
    });
    expect(report.status).toBe(200);
    expect(
      readFileSync(
        join(dir, "data", "agents", "reports", "weekly-2026-10-28.md"),
        "utf8",
      ),
    ).toBe("# Revue");
  });
});
