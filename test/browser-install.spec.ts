import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, test, vi } from "vitest";

// @ts-expect-error plain .mjs script, no types
import { pinDependencies } from "../scripts/pin-dist-deps.mjs";
import {
  type BrowserState,
  BrowserUnavailableError,
  browserState,
  ensureBrowsers,
  isMissingExecutable,
  launchWithInstall,
  resetBrowserState,
  useReachableBrowsersPath,
} from "../src/api/collectors/browserInstall.ts";

/** The error production logged from 2026-11-02 (epic 23). */
const MISSING = new Error(
  "browserType.launch: Executable doesn't exist at /opt/bay/data/apps/minpricing-production/browsers/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell\n╔══════╗\n║ Looks like Playwright Test or Playwright was just installed or updated. ║\n║ Please run the following command to download new browsers: ║",
);

beforeEach(() => resetBrowserState());

describe("launchWithInstall", () => {
  test("a missing Chromium is installed once, then the launch is retried", async () => {
    const launch = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(MISSING)
      .mockResolvedValueOnce("browser");
    const install = vi.fn<() => Promise<BrowserState>>(async () =>
      ensureBrowsers(async () => {}),
    );
    await expect(launchWithInstall(launch, install)).resolves.toBe("browser");
    expect(install).toHaveBeenCalledTimes(1);
    expect(launch).toHaveBeenCalledTimes(2);
    expect(browserState().state).toBe("ready");
  });

  test("an install that fails says the browser is unavailable", async () => {
    const launch = vi.fn<() => Promise<string>>().mockRejectedValue(MISSING);
    const install = () =>
      ensureBrowsers(async () => {
        throw new Error("ENOSPC: no space left on device");
      });
    const error = await launchWithInstall(launch, install).catch((e) => e);
    expect(error).toBeInstanceOf(BrowserUnavailableError);
    expect(error.message).toMatch(
      /^Navigateur indisponible sur le serveur : Chromium absent et installation impossible \(ENOSPC/,
    );
    expect(browserState()).toMatchObject({ state: "failed" });
  });

  test("other launch errors are not an install problem", async () => {
    const install = vi.fn<() => Promise<BrowserState>>();
    await expect(
      launchWithInstall(
        () => Promise.reject(new Error("Target closed")),
        install,
      ),
    ).rejects.toThrow("Target closed");
    expect(install).not.toHaveBeenCalled();
  });
});

describe("ensureBrowsers", () => {
  test("one install at a time: callers meanwhile share it", async () => {
    let release = () => {};
    const install = vi.fn<() => Promise<void>>(
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    const first = ensureBrowsers(install);
    const second = ensureBrowsers(install);
    expect(browserState().state).toBe("installing");
    release();
    await Promise.all([first, second]);
    expect(install).toHaveBeenCalledTimes(1);
    expect(browserState().state).toBe("ready");
  });

  test("recognises Playwright's missing-executable error", () => {
    expect(isMissingExecutable(MISSING)).toBe(true);
    expect(isMissingExecutable(new Error("net::ERR_TIMED_OUT"))).toBe(false);
  });
});

describe("Playwright is pinned to the tested version", () => {
  test("package.json names an exact version, not a range", () => {
    const pkg = JSON.parse(
      readFileSync(join(import.meta.dirname, "../package.json"), "utf8"),
    );
    for (const name of ["playwright", "playwright-core"]) {
      expect(pkg.dependencies[name]).toMatch(/^\d+\.\d+\.\d+$/);
    }
    expect(pkg.scripts.build).toContain("pin-dist-deps");
  });

  test("dist/package.json ranges become the installed versions", () => {
    expect(
      pinDependencies(
        { playwright: "^1.63.0", "playwright-core": "^1.63.0", gone: "^1.0.0" },
        (name: string) => (name === "gone" ? undefined : "1.63.0"),
      ),
    ).toEqual({
      playwright: "1.63.0",
      "playwright-core": "1.63.0",
      gone: "^1.0.0",
    });
  });
});

describe("useReachableBrowsersPath", () => {
  beforeEach(() => resetBrowserState());

  test("keeps Bay's folder when it can be created", () => {
    const env = { PLAYWRIGHT_BROWSERS_PATH: "/opt/bay/app/browsers" };
    const path = useReachableBrowsersPath(
      env,
      () => {},
      () => "/files/browsers",
    );
    expect(path).toBe("/opt/bay/app/browsers");
  });

  test("moves to the app's files when mkdir fails (ENOENT)", () => {
    const env = { PLAYWRIGHT_BROWSERS_PATH: "/opt/bay/app/browsers" };
    const path = useReachableBrowsersPath(
      env,
      () => {
        throw new Error("ENOENT: no such file or directory, mkdir");
      },
      () => "/files/browsers",
    );
    expect(path).toBe("/files/browsers");
    expect(env.PLAYWRIGHT_BROWSERS_PATH).toBe("/files/browsers");
  });

  test("no variable: Playwright's default cache, untouched", () => {
    const env: NodeJS.ProcessEnv = {};
    expect(useReachableBrowsersPath(env, () => {})).toBeUndefined();
    expect(env.PLAYWRIGHT_BROWSERS_PATH).toBeUndefined();
  });
});
