import { Alepha } from "alepha";
import { describe, expect, test, vi } from "vitest";

import { ApiModule } from "../src/api/index.ts";
import {
  CollectionJournalService,
  runStatusOf,
} from "../src/api/services/CollectionJournalService.ts";

const ok = { id: "a", collected: 5, created: 1, updated: 4 };
const bad = { ...ok, id: "b", error: "boom" };

describe("runStatusOf", () => {
  test("ok, partial, failed", () => {
    expect(runStatusOf([ok])).toBe("ok");
    expect(runStatusOf([])).toBe("ok");
    expect(runStatusOf([ok, bad])).toBe("partial");
    expect(runStatusOf([bad])).toBe("failed");
  });
});

describe("CollectionJournalService", () => {
  async function setup() {
    const alepha = Alepha.create({
      env: { ADMIN_USERNAME: "a", ADMIN_PASSWORD: "a" },
    }).with(ApiModule);
    await alepha.start();
    const journal = alepha.inject(CollectionJournalService);
    const runs = (
      journal as unknown as {
        runs: {
          findMany(q?: object): Promise<Array<Record<string, unknown>>>;
          getById(id: string): Promise<Record<string, unknown>>;
        };
      }
    ).runs;
    return { journal, runs };
  }

  test("a run is opened as running and closed with its results", async () => {
    const { journal, runs } = await setup();
    const id = await journal.open("manual");
    expect((await runs.getById(id!)).status).toBe("running");
    await journal.close(id, { status: "partial", results: [ok, bad] });
    const row = await runs.getById(id!);
    expect(row.status).toBe("partial");
    expect(JSON.parse(row.results as string)).toHaveLength(2);
    expect(row.endedAt).toBeTruthy();
  });

  test("a crash keeps its message", async () => {
    const { journal, runs } = await setup();
    const id = await journal.open("schedule");
    await journal.close(id, { status: "failed", error: "db down" });
    expect((await runs.getById(id!)).error).toBe("db down");
  });

  test("a skipped run leaves a row with its reason", async () => {
    const { journal, runs } = await setup();
    await journal.recordSkipped("schedule", "déjà en cours");
    const rows = await runs.findMany();
    expect(rows.some((r) => r.status === "skipped")).toBe(true);
  });

  test("stale running rows are closed as failed", async () => {
    const { journal, runs } = await setup();
    const id = await journal.open("schedule");
    await journal.tidy();
    expect((await runs.getById(id!)).status).toBe("failed");
  });

  test("a write error is logged, never thrown", async () => {
    const { journal, runs } = await setup();
    vi.spyOn(
      runs as unknown as { create: () => Promise<never> },
      "create",
    ).mockRejectedValue(new Error("disk full"));
    await expect(journal.open("schedule")).resolves.toBeUndefined();
    await expect(journal.close(undefined, { status: "ok" })).resolves.toBe(
      undefined,
    );
  });
});
