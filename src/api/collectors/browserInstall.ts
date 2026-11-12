/**
 * Keeps Playwright's Chromium builds installed on the server. They live
 * outside the app (`PLAYWRIGHT_BROWSERS_PATH`, Bay's `browsers/` folder),
 * were installed by hand once, and went missing on the VM on 2026-11-02:
 * every browser source then failed with « Executable doesn't exist »
 * (epic 23). Now the app installs what it needs itself, with Playwright's
 * own installer: at startup, and once more when a launch finds the
 * executable missing. Node only: imported by `browser.ts`, whose
 * Node branch alone runs it.
 */

import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import { appDir } from "../services/appDir.ts";

export interface BrowserState {
  state: "unknown" | "installing" | "ready" | "failed";
  /** What went wrong, in French, when `failed`. */
  detail?: string;
  checkedAt?: string;
  /** Where the builds are, when not where Bay said (see below). */
  path?: string;
}

/** A browser that can't start: not a page problem. */
export class BrowserUnavailableError extends Error {
  constructor(reason: string) {
    super(`Navigateur indisponible sur le serveur : ${reason}`);
    this.name = "BrowserUnavailableError";
  }
}

/** The Chromium builds collection (headless) and Dealabs (visible) use. */
/** Where `docker/runtime` installs the builds. */
export const IMAGE_BROWSERS_PATH = "/ms-playwright";

export const BROWSER_BUILDS = ["chromium", "chromium-headless-shell"];

let current: BrowserState = { state: "unknown" };
let movedFrom: string | undefined;
let movedTo: string | undefined;

/**
 * Bay sets `PLAYWRIGHT_BROWSERS_PATH` to a folder beside the app that the
 * app can't create (2026-11-03: « ENOENT: mkdir …/browsers », its parent is
 * a dangling link or a parent the app can't see). When that folder can't
 * be created, the builds go to `browsers/` under the app's persistent files
 * (`appDir()`) instead. Must run before the first `import("playwright")`,
 * which reads the variable once.
 */
export function ensureReachableBrowsersPath(
  env: NodeJS.ProcessEnv = process.env,
  create: (path: string) => void = (path) =>
    mkdirSync(path, { recursive: true }),
  fallback: () => string = () => join(appDir(), "browsers"),
): string | undefined {
  ensureReachableTmpDir(env, create);
  // The runtime image's own builds win over any configured folder: a value
  // left over from the old process-based Bay (its `browsers/` path) would
  // otherwise send Playwright looking for builds that aren't there.
  // Bay sets PLAYWRIGHT_BROWSERS_PATH itself at every start (…/browsers),
  // so an image built before DEALRADAR_BROWSERS_PATH existed falls back to
  // where docker/runtime puts them.
  const shipped =
    env.DEALRADAR_BROWSERS_PREINSTALLED === "1"
      ? env.DEALRADAR_BROWSERS_PATH || IMAGE_BROWSERS_PATH
      : undefined;
  if (shipped) {
    env.PLAYWRIGHT_BROWSERS_PATH = shipped;
    return shipped;
  }
  const configured = env.PLAYWRIGHT_BROWSERS_PATH;
  if (!configured || configured === "0" || configured === movedTo) {
    return configured;
  }
  try {
    create(configured);
    return configured;
  } catch {
    // e.g. a dangling symlink, or a parent the app can't see.
  }
  movedFrom ??= configured;
  movedTo = fallback();
  env.PLAYWRIGHT_BROWSERS_PATH = movedTo;
  return env.PLAYWRIGHT_BROWSERS_PATH;
}
/**
 * Playwright makes its launch folder under `os.tmpdir()`. A `TMPDIR` left
 * over from the old process-based Bay (`…/scratch/.tmp`, 2026-11-10) does
 * not exist in the container and every launch failed with « ENOENT …
 * mkdtemp ». When it can't be created, the variables go and the system
 * `/tmp` is used.
 */
export function ensureReachableTmpDir(
  env: NodeJS.ProcessEnv = process.env,
  create: (path: string) => void = (path) =>
    mkdirSync(path, { recursive: true }),
): void {
  for (const key of ["TMPDIR", "TMP", "TEMP"]) {
    const dir = env[key];
    if (!dir) continue;
    try {
      create(dir);
    } catch {
      delete env[key];
    }
  }
  // Bay gives the container a 64 MB tmpfs `/tmp`, and Playwright starts
  // Chromium with `--disable-dev-shm-usage`, so its shared memory goes to
  // the temp folder: a heavy page (an Amazon product page) fills it and the
  // renderer dies — « Page crashed », 12 of 13 product pages on 2026-11-10.
  // In the runtime image, with no temp folder set, use one on the data disk.
  // The app's persistent files first: Bay's DATA_DIR is its `scratch/`
  // folder, which a container may not see (« ENOENT … scratch/.tmp »).
  const base = env.APP_FILES_DIR || env.DATA_DIR;
  if (env.DEALRADAR_BROWSERS_PREINSTALLED === "1" && base && !env.TMPDIR) {
    const dir = join(base, ".tmp");
    try {
      create(dir);
      env.TMPDIR = dir;
    } catch {
      // Keep the system /tmp.
    }
  }
}

let pending: Promise<BrowserState> | undefined;

export const browserState = (): BrowserState => ({
  ...current,
  ...(movedFrom ? { path: process.env.PLAYWRIGHT_BROWSERS_PATH } : {}),
});

/** Playwright's « Executable doesn't exist at … » launch error. */
export function isMissingExecutable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /Executable doesn't exist|Please run the following command to download new browsers|playwright install/i.test(
    message,
  );
}

const short = (error: unknown) =>
  (error instanceof Error ? error.message : String(error))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);

/**
 * The runtime image (`docker/runtime`) ships Chromium and says so with
 * `DEALRADAR_BROWSERS_PREINSTALLED=1`. Bay runs it on a read-only root
 * filesystem, where Playwright's installer hangs on its lock file instead
 * of finding the builds already there — and every launch waits for that
 * install. So with the flag, « install » only checks the executable.
 */
async function checkPreinstalledBrowsers(): Promise<void> {
  const { existsSync } = await import("node:fs");
  const { chromium } = await import("playwright");
  const executable = chromium.executablePath();
  if (!existsSync(executable)) {
    throw new Error(
      `Chromium absent de l'image d'exécution (attendu : ${executable})`,
    );
  }
}

/** Runs `playwright install chromium chromium-headless-shell`. */
async function runPlaywrightInstall(): Promise<void> {
  if (process.env.DEALRADAR_BROWSERS_PREINSTALLED === "1") {
    return checkPreinstalledBrowsers();
  }
  const { spawn } = await import("node:child_process");
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  const cli = join(
    dirname(require.resolve("playwright/package.json")),
    "cli.js",
  );
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [cli, "install", ...BROWSER_BUILDS], {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    // Playwright prints its reasons on either stream.
    let output = "";
    const keep = (chunk: unknown) => {
      output = (output + String(chunk)).slice(-2_000);
    };
    child.stdout?.on("data", keep);
    child.stderr?.on("data", keep);
    const timer = setTimeout(() => child.kill("SIGKILL"), 15 * 60_000);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else
        reject(
          new Error(
            `installation Playwright échouée (code ${code}) : ${output.replace(/\s+/g, " ").trim().slice(-400) || "aucune sortie"}`,
          ),
        );
    });
  });
}

/**
 * Installs the missing builds (a no-op, a second or so, when they are all
 * there). One install at a time: callers arriving meanwhile wait for it.
 * Never throws: the outcome is in the returned state.
 */
export function ensureBrowsers(
  install: () => Promise<void> = runPlaywrightInstall,
): Promise<BrowserState> {
  ensureReachableBrowsersPath();
  pending ??= (async () => {
    current = { state: "installing", checkedAt: new Date().toISOString() };
    try {
      await install();
      current = { state: "ready", checkedAt: new Date().toISOString() };
    } catch (error) {
      current = {
        state: "failed",
        detail: short(error),
        checkedAt: new Date().toISOString(),
      };
    } finally {
      pending = undefined;
    }
    return current;
  })();
  return pending;
}

/**
 * Launches through `launch`; when Playwright says the executable is
 * missing, installs the builds once and tries again. A browser that still
 * can't start throws {@link BrowserUnavailableError}.
 */
export async function launchWithInstall<T>(
  launch: () => Promise<T>,
  install: () => Promise<BrowserState> = () => ensureBrowsers(),
): Promise<T> {
  ensureReachableBrowsersPath();
  if (pending) await pending;
  try {
    const browser = await launch();
    if (current.state !== "ready") {
      current = { state: "ready", checkedAt: new Date().toISOString() };
    }
    return browser;
  } catch (error) {
    if (!isMissingExecutable(error)) throw error;
    const installed = await install();
    if (installed.state !== "ready") {
      throw new BrowserUnavailableError(
        `Chromium absent et installation impossible (${installed.detail ?? "raison inconnue"})`,
      );
    }
    try {
      return await launch();
    } catch (retry) {
      current = {
        state: "failed",
        detail: short(retry),
        checkedAt: new Date().toISOString(),
      };
      throw new BrowserUnavailableError(short(retry));
    }
  }
}

/** Tests only. */
export function resetBrowserState(): void {
  current = { state: "unknown" };
  pending = undefined;
  movedFrom = undefined;
  movedTo = undefined;
}
