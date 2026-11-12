import { accessSync, constants, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { $logger } from "alepha/logger";

import { launchWithInstall } from "../collectors/browserInstall.ts";

type Page = import("playwright").Page;
type Browser = import("playwright").Browser;

/** Size of the Dealabs window, also the coordinate space of clicks. */
export const SCREEN_VIEWPORT = { width: 1280, height: 800 } as const;

export interface RemoteScreenSnapshot {
  active: boolean;
  label?: string;
  url?: string;
  /** JPEG data URL of the window. */
  image?: string;
  width: number;
  height: number;
}

/**
 * Launches the visible Chromium used for Dealabs (login and publishing).
 * On a server it draws on a virtual display (Xvfb, `DISPLAY=:99`); Chrome
 * also needs a writable home for its crash reporter, which a Bay app user
 * doesn't have — without one it dies on launch.
 */
/** A person can see the browser (local desktop, or the server's virtual display). */
export const isAttended = (): boolean =>
  process.platform !== "linux" || !!process.env.DISPLAY;

const writable = (dir: string | undefined): dir is string => {
  if (!dir || !existsSync(dir)) return false;
  try {
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
};

/**
 * A home Chrome can write to: its crash reporter dies on launch without one
 * (« chrome_crashpad_handler: --database is required »). The app user's
 * `HOME` may exist and still be read-only (new VPS, 2026-11-11).
 */
export function browserHome(env: NodeJS.ProcessEnv = process.env): string {
  if (writable(env.HOME)) return env.HOME;
  const home = join(tmpdir(), "dealradar-browser-home");
  mkdirSync(home, { recursive: true });
  return home;
}

export async function launchVisibleBrowser(): Promise<Browser> {
  const { chromium } = await import("playwright");
  const home = browserHome();
  return launchWithInstall(() =>
    chromium.launch({
      // No display (no Xvfb on the server): a visible Chrome can't start,
      // so publish headless with the saved session; the robot check and
      // the login then stop with their « pas d'écran » message.
      headless: !isAttended(),
      env: {
        ...process.env,
        HOME: home,
        XDG_CONFIG_HOME: join(home, ".config"),
        XDG_CACHE_HOME: join(home, ".cache"),
      },
      // Keep cross-site frames in the page's process: the Bay app's task and
      // memory caps on the VM can't afford one ~100 MB renderer per frame.
      args: [
        "--renderer-process-limit=2",
        "--disable-site-isolation-trials",
        "--disable-features=IsolateOrigins,site-per-process",
        "--disable-crash-reporter",
        "--disable-breakpad",
      ],
    }),
  );
}

/** Frames the Dealabs window may load: Dealabs, its robot check and logins. */
/**
 * Hosts the Dealabs window may load: Dealabs itself, its robot checks
 * (Cloudflare, reCAPTCHA, hCaptcha) and the « Se connecter avec » login
 * providers. Everything else on a Dealabs page is ads, bidding and tracking.
 */
const ALLOWED_HOSTS =
  /(^|\.)(dealabs\.com|pepper\.com|pepperstatic\.com|cloudflare\.com|google\.com|googleapis\.com|gstatic\.com|recaptcha\.net|hcaptcha\.com|apple\.com|facebook\.com|fbcdn\.net)$/;

/**
 * Blocks third-party requests (ads, header bidding, trackers) in the Dealabs
 * window. With a saved session's consent cookies a Dealabs page loads ~40
 * of them and ~20 ad iframes, each its own ~100 MB Chrome process — more
 * than the VM's app budget. Measured on the VM: 23 renderers → 2 with this
 * and the shared-process flags in `launchVisibleBrowser`. Robot checks and
 * login providers stay allowed.
 */
export async function blockThirdParty(
  context: import("playwright").BrowserContext,
): Promise<void> {
  await context.route("**/*", (route) => {
    let host = "";
    try {
      host = new URL(route.request().url()).hostname;
    } catch {
      // data:/blob: URLs have no host: let them through.
    }
    if (host && !ALLOWED_HOSTS.test(host)) return route.abort();
    return route.continue();
  });
}

/**
 * The console's view of the Dealabs window when the server has no screen
 * you can look at (the VM): the login and the publisher register their
 * page here, the console polls a screenshot and sends back your clicks and
 * typing. You still do the login and any « je ne suis pas un robot » check
 * yourself — this only carries the picture and your input. Keystrokes are
 * passed to the page and never logged or stored.
 */
export class RemoteScreenService {
  protected log = $logger();
  protected page?: Page;
  protected label?: string;

  /** Shows `page` in the console until it closes or another one is attached. */
  attach(page: Page, label: string): void {
    this.page = page;
    this.label = label;
    page.once("close", () => this.detach(page));
  }

  detach(page: Page): void {
    if (this.page === page) {
      this.page = undefined;
      this.label = undefined;
    }
  }

  /** A Dealabs window is open right now (login or publication). */
  isActive(): boolean {
    return !!this.activePage();
  }

  async snapshot(): Promise<RemoteScreenSnapshot> {
    const page = this.activePage();
    const base = { ...SCREEN_VIEWPORT, active: false };
    if (!page) return base;
    try {
      const buffer = await page.screenshot({
        type: "jpeg",
        quality: 60,
        timeout: 5_000,
      });
      return {
        ...base,
        active: true,
        label: this.label,
        url: page.url(),
        image: `data:image/jpeg;base64,${buffer.toString("base64")}`,
      };
    } catch {
      // Mid-navigation: say it's there, the next poll gets the picture.
      return { ...base, active: true, label: this.label, url: page.url() };
    }
  }

  async click(x: number, y: number): Promise<void> {
    const page = this.requirePage();
    await page.mouse.click(
      clamp(x, 0, SCREEN_VIEWPORT.width - 1),
      clamp(y, 0, SCREEN_VIEWPORT.height - 1),
    );
  }

  async scroll(deltaY: number): Promise<void> {
    await this.requirePage().mouse.wheel(0, clamp(deltaY, -2000, 2000));
  }

  async type(text: string): Promise<void> {
    await this.requirePage().keyboard.type(text, { delay: 30 });
  }

  async press(key: RemoteKey): Promise<void> {
    await this.requirePage().keyboard.press(key);
  }

  protected activePage(): Page | undefined {
    if (this.page?.isClosed()) {
      this.page = undefined;
    }
    return this.page;
  }

  protected requirePage(): Page {
    const page = this.activePage();
    if (!page) {
      throw new Error("Aucune fenêtre Dealabs ouverte en ce moment.");
    }
    return page;
  }
}

export const REMOTE_KEYS = [
  "Enter",
  "Tab",
  "Backspace",
  "Escape",
  "ArrowUp",
  "ArrowDown",
] as const;
export type RemoteKey = (typeof REMOTE_KEYS)[number];

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}
