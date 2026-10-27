import { join } from "node:path";

/**
 * Where the app keeps what must survive a deploy: the Dealabs session, debug
 * snapshots, run logs and `config/`. Locally it is the project folder; on a
 * host whose release folder is replaced and read-only (Bay), `APP_FILES_DIR`
 * points at a persistent writable folder instead.
 */
export const appFile = (...parts: string[]): string =>
  join(process.env.APP_FILES_DIR || process.cwd(), ...parts);

/**
 * Chromium launch options. `BROWSER_NO_SANDBOX=true` is for service sandboxes
 * (systemd `RestrictNamespaces`) where Chromium's own sandbox cannot start;
 * `BROWSER_HEADLESS=true` is for hosts without a display, where a visible
 * window cannot open.
 */
export const chromiumOptions = (headless: boolean) => ({
  headless: headless || process.env.BROWSER_HEADLESS === "true",
  args: [
    "--disable-gpu",
    "--disable-extensions",
    "--disable-background-networking",
    ...(process.env.BROWSER_NO_SANDBOX === "true"
      ? ["--no-sandbox", "--disable-dev-shm-usage"]
      : []),
  ],
});
