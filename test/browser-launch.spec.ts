import { chmodSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import {
  browserHome,
  isAttended,
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
