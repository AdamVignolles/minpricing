import { existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { $logger } from "alepha/logger";

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
export async function launchVisibleBrowser(): Promise<Browser> {
  const { chromium } = await import("playwright");
  const home =
    process.env.HOME && existsSync(process.env.HOME)
      ? process.env.HOME
      : join(tmpdir(), "dealradar-browser-home");
  mkdirSync(home, { recursive: true });
  return chromium.launch({
    headless: false,
    env: { ...process.env, HOME: home },
    // Dealabs' ad iframes otherwise get one renderer process each (~15),
    // which exhausts the Bay app's task and memory caps on the VM.
    args: ["--renderer-process-limit=2"],
  });
}

/** Frames the Dealabs window may load: Dealabs, its robot check and logins. */
const ALLOWED_FRAME_HOSTS =
  /(^|\.)(dealabs\.com|pepper\.com|cloudflare\.com|google\.com|gstatic\.com|recaptcha\.net|hcaptcha\.com|apple\.com|facebook\.com)$/;

/**
 * Skips third-party iframes (ads, trackers) in the Dealabs window: with
 * site isolation each one is its own ~100 MB Chrome process, ~20 on a
 * Dealabs page — more than the VM's app budget. Only sub-frame documents
 * are blocked; the page itself, its scripts and any robot-check or login
 * frame load normally.
 */
export async function skipThirdPartyFrames(
  context: import("playwright").BrowserContext,
): Promise<void> {
  await context.route("**/*", (route) => {
    const request = route.request();
    try {
      if (
        request.resourceType() === "document" &&
        request.frame().parentFrame() &&
        !ALLOWED_FRAME_HOSTS.test(new URL(request.url()).hostname)
      ) {
        return route.abort();
      }
    } catch {
      // Service-worker requests have no frame: let them through.
    }
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
