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
  reachableBrowsersPath,
  useReachableTmpDir,
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

describe("reachableBrowsersPath", () => {
  beforeEach(() => resetBrowserState());

  test("keeps Bay's folder when it can be created", () => {
    const env = { PLAYWRIGHT_BROWSERS_PATH: "/opt/bay/app/browsers" };
    const path = reachableBrowsersPath(
      env,
      () => {},
      () => "/files/browsers",
    );
    expect(path).toBe("/opt/bay/app/browsers");
  });

  test("moves to the app's files when mkdir fails (ENOENT)", () => {
    const env = { PLAYWRIGHT_BROWSERS_PATH: "/opt/bay/app/browsers" };
    const path = reachableBrowsersPath(
      env,
      () => {
        throw new Error("ENOENT: no such file or directory, mkdir");
      },
      () => "/files/browsers",
    );
    expect(path).toBe("/files/browsers");
    expect(env.PLAYWRIGHT_BROWSERS_PATH).toBe("/files/browsers");
  });

  test("the runtime image's builds win over a leftover folder", () => {
    const env: NodeJS.ProcessEnv = {
      PLAYWRIGHT_BROWSERS_PATH:
        "/opt/bay/data/apps/minpricing-production/browsers",
      DEALRADAR_BROWSERS_PREINSTALLED: "1",
      DEALRADAR_BROWSERS_PATH: "/ms-playwright",
    };
    const path = reachableBrowsersPath(
      env,
      () => {
        throw new Error("must not try the leftover folder");
      },
      () => "/files/browsers",
    );
    expect(path).toBe("/ms-playwright");
    expect(env.PLAYWRIGHT_BROWSERS_PATH).toBe("/ms-playwright");
  });

  test("runtime image built before DEALRADAR_BROWSERS_PATH: its /ms-playwright, not Bay's folder", () => {
    const env: NodeJS.ProcessEnv = {
      PLAYWRIGHT_BROWSERS_PATH:
        "/opt/bay/data/apps/minpricing-production/browsers",
      DEALRADAR_BROWSERS_PREINSTALLED: "1",
    };
    expect(
      reachableBrowsersPath(
        env,
        () => {
          throw new Error("ENOENT");
        },
        () => "/opt/bay/data/apps/minpricing-production/data/browsers",
      ),
    ).toBe("/ms-playwright");
    expect(env.PLAYWRIGHT_BROWSERS_PATH).toBe("/ms-playwright");
  });

  test("no variable: Playwright's default cache, untouched", () => {
    const env: NodeJS.ProcessEnv = {};
    expect(reachableBrowsersPath(env, () => {})).toBeUndefined();
    expect(env.PLAYWRIGHT_BROWSERS_PATH).toBeUndefined();
  });
});

describe("useReachableTmpDir", () => {
  test("a TMPDIR that can't be created is dropped: the system /tmp is used", () => {
    const env: NodeJS.ProcessEnv = {
      TMPDIR: "/opt/bay/data/apps/minpricing-production/scratch/.tmp",
    };
    useReachableTmpDir(env, () => {
      throw new Error("ENOENT: no such file or directory, mkdir");
    });
    expect(env.TMPDIR).toBeUndefined();
  });

  test("runtime image without a temp folder: one on the data disk, not Bay's 64 MB /tmp", () => {
    const env: NodeJS.ProcessEnv = {
      DEALRADAR_BROWSERS_PREINSTALLED: "1",
      DATA_DIR: "/opt/bay/data/apps/minpricing-production/data",
    };
    const made: string[] = [];
    useReachableTmpDir(env, (path) => {
      made.push(path);
    });
    expect(env.TMPDIR).toBe(
      "/opt/bay/data/apps/minpricing-production/data/.tmp",
    );
    expect(made).toEqual([
      "/opt/bay/data/apps/minpricing-production/data/.tmp",
    ]);
  });

  test("Bay's unreachable scratch TMPDIR: the app's files folder instead", () => {
    const env: NodeJS.ProcessEnv = {
      DEALRADAR_BROWSERS_PREINSTALLED: "1",
      DATA_DIR: "/opt/bay/data/apps/minpricing-production/scratch",
      APP_FILES_DIR: "/opt/bay/data/apps/minpricing-production/data",
      TMPDIR: "/opt/bay/data/apps/minpricing-production/scratch/.tmp",
    };
    useReachableTmpDir(env, (path) => {
      if (path.includes("scratch")) throw new Error("ENOENT");
    });
    expect(env.TMPDIR).toBe(
      "/opt/bay/data/apps/minpricing-production/data/.tmp",
    );
  });

  test("an explicit TMPDIR is never replaced", () => {
    const env: NodeJS.ProcessEnv = {
      DEALRADAR_BROWSERS_PREINSTALLED: "1",
      DATA_DIR: "/data",
      TMPDIR: "/elsewhere",
    };
    useReachableTmpDir(env, () => {});
    expect(env.TMPDIR).toBe("/elsewhere");
  });

  test("a TMPDIR that exists or can be made is kept", () => {
    const env: NodeJS.ProcessEnv = { TMPDIR: "/data/tmp" };
    useReachableTmpDir(env, () => {});
    expect(env.TMPDIR).toBe("/data/tmp");
  });
});
