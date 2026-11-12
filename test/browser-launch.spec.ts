import { chmodSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import {
  browserHome,
  isAttended,
  replayPlan,
} from "../src/api/services/RemoteScreenService.ts";

describe("launchVisibleBrowser's home (new VPS, 2026-11-11)", () => {
  test("a writable HOME is kept", () => {
    const home = mkdtempSync(join(tmpdir(), "home-"));
    expect(browserHome({ HOME: home })).toBe(home);
  });

  test("a missing or read-only HOME falls back to a temp home", () => {
    const fallback = join(tmpdir(), "dealradar-browser-home");
    expect(browserHome({ HOME: "/nonexistent-home" })).toBe(fallback);
    expect(browserHome({})).toBe(fallback);
  });

  // root writes anywhere, so a read-only home can only be seen as another user.
  test.skipIf(process.getuid?.() === 0)("a read-only HOME too", () => {
    const ro = mkdtempSync(join(tmpdir(), "ro-home-"));
    chmodSync(ro, 0o500);
    expect(browserHome({ HOME: ro })).toBe(
      join(tmpdir(), "dealradar-browser-home"),
    );
  });

  test("no display on Linux: not attended (headless publish)", () => {
    const display = process.env.DISPLAY;
    delete process.env.DISPLAY;
    try {
      expect(isAttended()).toBe(process.platform !== "linux");
    } finally {
      if (display !== undefined) process.env.DISPLAY = display;
    }
  });
});

describe("écran distant: a click is replayed as it was made", () => {
  test("the pointer's trail, its timings, then press and release", () => {
    const steps = replayPlan({
      trail: [
        { x: 400, y: 300, dt: 0 },
        { x: 250, y: 380, dt: 40 },
        { x: 100, y: 445, dt: 60 },
      ],
      x: 93,
      y: 449,
      hold: 85,
    });
    expect(steps).toEqual([
      { kind: "move", x: 400, y: 300, wait: 0 },
      { kind: "move", x: 250, y: 380, wait: 40 },
      { kind: "move", x: 100, y: 445, wait: 60 },
      { kind: "move", x: 93, y: 449, wait: 0 },
      { kind: "down", wait: 0 },
      { kind: "up", wait: 85 },
    ]);
  });

  test("no trail is a plain click; nothing is invented", () => {
    expect(replayPlan({ trail: [], x: 10, y: 20, hold: 0 })).toEqual([
      { kind: "move", x: 10, y: 20, wait: 0 },
      { kind: "down", wait: 0 },
      { kind: "up", wait: 0 },
    ]);
  });

  test("bounded: 3 s of trail at most, inside the window", () => {
    const steps = replayPlan({
      trail: Array.from({ length: 300 }, () => ({ x: 5000, y: -9, dt: 400 })),
      x: 5,
      y: 5,
      hold: 60_000,
    });
    const moves = steps.filter((step) => step.kind === "move");
    expect(moves.length).toBeLessThanOrEqual(9);
    expect(moves[0]).toMatchObject({ x: 1279, y: 0 });
    expect(steps.at(-1)).toEqual({ kind: "up", wait: 1500 });
  });
});
