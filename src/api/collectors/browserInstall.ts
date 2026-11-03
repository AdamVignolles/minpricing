/**
 * Keeps Playwright's Chromium builds installed on the server. They live
 * outside the app (`PLAYWRIGHT_BROWSERS_PATH`, Bay's `browsers/` folder),
 * were installed by hand once, and went missing on the VM on 2026-11-02:
 * every browser source then failed with « Executable doesn't exist »
 * (epic 23). Now the app installs what it needs itself, with Playwright's
 * own installer: at startup, and once more when a launch finds the
 * executable missing. Node only; never imported on Workers (dynamic
 * imports, like `playwright` itself).
 */

export interface BrowserState {
  state: "unknown" | "installing" | "ready" | "failed";
  /** What went wrong, in French, when `failed`. */
  detail?: string;
  checkedAt?: string;
}

/** A browser that can't start: not a page problem. */
export class BrowserUnavailableError extends Error {
  constructor(reason: string) {
    super(`Navigateur indisponible sur le serveur : ${reason}`);
    this.name = "BrowserUnavailableError";
  }
}

/** The Chromium builds collection (headless) and Dealabs (visible) use. */
export const BROWSER_BUILDS = ["chromium", "chromium-headless-shell"];

let current: BrowserState = { state: "unknown" };
let pending: Promise<BrowserState> | undefined;

export const browserState = (): BrowserState => current;

/** Playwright's « Executable doesn't exist at … » launch error. */
export function isMissingExecutable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /Executable doesn't exist|Please run the following command to download new browsers|playwright install/i.test(
    message,
  );
}

const short = (error: unknown) =>
  (error instanceof Error ? error.message : String(error))
    .split("\n")[0]
    .replace(/\s+/g, " ")
    .slice(0, 160);

/** Runs `playwright install chromium chromium-headless-shell`. */
async function runPlaywrightInstall(): Promise<void> {
  const { spawn } = await import("node:child_process");
  const { createRequire } = await import("node:module");
  const { dirname, join } = await import("node:path");
  const require = createRequire(import.meta.url);
  const cli = join(
    dirname(require.resolve("playwright/package.json")),
    "cli.js",
  );
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [cli, "install", ...BROWSER_BUILDS], {
      env: process.env,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr = (stderr + String(chunk)).slice(-2_000);
    });
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
            `installation Playwright échouée (code ${code}) ${stderr.trim().slice(-300)}`,
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
}
