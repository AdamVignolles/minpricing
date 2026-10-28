import { describe, expect, test } from "vitest";

import {
  lastSlot,
  ROUTINES,
  routineHealth,
} from "../src/api/services/agentHealth.ts";

/**
 * Health of the scheduled cloud routines: each slot must leave its dated
 * file on the server; without it, past the grace time, the slot is missed.
 */
const spec = (id: string) => ROUTINES.find((r) => r.id === id)!;
const at = (iso: string) => new Date(iso);

describe("agent health", () => {
  test("last slot: weekdays only for the selection, UTC crons", () => {
    expect(
      lastSlot(spec("selection"), at("2026-10-28T15:50:00Z")).toISOString(),
    ).toBe("2026-10-27T16:00:00.000Z");
    expect(
      lastSlot(spec("selection"), at("2026-10-31T10:00:00Z")).toISOString(),
    ).toBe("2026-10-30T16:00:00.000Z");
    expect(
      lastSlot(spec("revue"), at("2026-10-28T21:45:00Z")).toISOString(),
    ).toBe("2026-10-28T21:45:00.000Z");
  });

  test("ok when the slot's file arrived, with what it changed", () => {
    const files: Record<string, Date> = {
      "queue-2026-10-27.json": at("2026-10-27T16:06:00Z"),
    };
    const h = routineHealth(
      spec("selection"),
      at("2026-10-28T15:50:00Z"),
      (p) => files[p],
      [
        {
          agent: "deal-selector",
          kind: "schedule",
          target: "2026-10-27",
          createdAt: "2026-10-27T16:06:00Z",
        },
        {
          agent: "deal-selector",
          kind: "schedule",
          target: "2026-10-20",
          createdAt: "2026-10-20T16:06:00Z",
        },
      ],
    );
    expect(h).toMatchObject({
      status: "ok",
      lastRun: "2026-10-27T16:06:00.000Z",
      files: ["queue-2026-10-27.json"],
      changes: ["schedule 2026-10-27"],
      schedule: "lun.–ven. 17:00",
    });
  });

  test("missed past the grace time, running before it; an older file doesn't count", () => {
    const stale = {
      "reports/sources-2026-10-28.md": at("2026-10-28T09:00:00Z"),
    };
    expect(
      routineHealth(
        spec("sources"),
        at("2026-10-28T16:40:00Z"),
        (p) => stale[p as keyof typeof stale],
        [],
      ).status,
    ).toBe("running");
    expect(
      routineHealth(
        spec("sources"),
        at("2026-10-28T18:05:00Z"),
        (p) => stale[p as keyof typeof stale],
        [],
      ),
    ).toMatchObject({ status: "missed", files: [] });
  });

  test("bilan and revue share an agent: changes split at the revue's slot", () => {
    const writes = [
      {
        agent: "results-reviewer",
        kind: "config",
        target: "selection-lessons",
        createdAt: "2026-10-27T21:25:00Z",
      },
      {
        agent: "results-reviewer",
        kind: "config",
        target: "publish-rules",
        createdAt: "2026-10-27T21:55:00Z",
      },
      {
        agent: "results-reviewer",
        kind: "data",
        target: "report-2026-10-27.json",
        createdAt: "2026-10-27T21:26:00Z",
      },
    ];
    const now = at("2026-10-28T15:00:00Z");
    expect(
      routineHealth(spec("bilan"), now, () => undefined, writes).changes,
    ).toEqual(["config selection-lessons"]);
    expect(
      routineHealth(spec("revue"), now, () => undefined, writes).changes,
    ).toEqual(["config publish-rules"]);
  });
});
