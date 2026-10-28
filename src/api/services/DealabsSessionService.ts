import { existsSync, statSync, unlinkSync } from "node:fs";

import { $inject, Alepha } from "alepha";
import { $logger } from "alepha/logger";

import { isDealabsLoggedOut, SESSION_PATH } from "./DealabsPublisherService.ts";
import {
  launchVisibleBrowser,
  RemoteScreenService,
  SCREEN_VIEWPORT,
  blockThirdParty,
} from "./RemoteScreenService.ts";

/** How long the login window waits for you before giving up. */
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const POLL_MS = 2_000;

export interface DealabsSessionStatus {
  /** False on the serverless deployment: no local browser to open there. */
  available: boolean;
  connected: boolean;
  /** When the saved session was last written. */
  savedAt?: string;
  login?: {
    state: "waiting" | "saved" | "failed" | "cancelled";
    startedAt: string;
    message?: string;
  };
}

/**
 * Logs into Dealabs from the console, without any terminal command.
 *
 * « Se connecter à Dealabs » opens a real, visible browser window on the
 * server at Dealabs' login. You log in there yourself — password, 2FA,
 * captcha, whatever Dealabs asks — and the window notices on its own once
 * you're in, saves the session to `.dealabs-session.json` and closes.
 * Auto-publish then reuses that session. On the VM the window is on a
 * virtual display, shown in the console by `RemoteScreenService`: your
 * typing passes through the app to the window, it is never logged or
 * stored.
 *
 * Why a separate window rather than the browser tab you're using: a web
 * page can't read another site's cookies (they're httpOnly, and the
 * browser isolates them per site), so a login made in your own tab can't
 * be handed over to the server. Same local-only constraint as auto-publish.
 */
export class DealabsSessionService {
  protected log = $logger();
  protected alepha = $inject(Alepha);
  protected screen = $inject(RemoteScreenService);
  protected login?: DealabsSessionStatus["login"];
  /** The login is happening in a window opened by the publisher. */
  protected sharedWindow = false;

  status(): DealabsSessionStatus {
    const connected = existsSync(SESSION_PATH);
    if (
      this.sharedWindow &&
      this.login?.state === "waiting" &&
      !this.screen.isActive()
    ) {
      this.sharedWindow = false;
      const saved =
        connected &&
        statSync(SESSION_PATH).mtime.toISOString() > this.login.startedAt;
      this.login = saved
        ? { ...this.login, state: "saved" }
        : {
            ...this.login,
            state: "cancelled",
            message: "Fenêtre Dealabs fermée avant la connexion.",
          };
    }
    return {
      available: !this.alepha.isServerless(),
      connected,
      savedAt: connected
        ? statSync(SESSION_PATH).mtime.toISOString()
        : undefined,
      login: this.login,
    };
  }

  /** Opens the login window (no-op if one is already open). */
  startLogin(): DealabsSessionStatus {
    if (this.alepha.isServerless()) {
      throw new Error(
        "La connexion Dealabs ouvre une fenêtre de navigateur sur la machine : disponible uniquement avec le serveur local.",
      );
    }
    if (this.login?.state !== "waiting") {
      this.login = { state: "waiting", startedAt: new Date().toISOString() };
      // A publication already has the Dealabs window open (and is waiting
      // for this very login): log in there instead of starting a second
      // browser, which the VM has no room for.
      if (this.screen.isActive()) {
        this.sharedWindow = true;
        return this.status();
      }
      void this.runLogin().catch((error: unknown) => {
        const full = error instanceof Error ? error.message : String(error);
        this.log.warn(`Dealabs login failed: ${full}`);
        // Playwright appends pages of browser logs: keep the first line.
        const message = full.split("\n")[0].split(" Browser logs:")[0];
        this.login = { ...this.login!, state: "failed", message };
      });
    }
    return this.status();
  }

  disconnect(): DealabsSessionStatus {
    if (existsSync(SESSION_PATH)) {
      unlinkSync(SESSION_PATH);
    }
    this.login = undefined;
    return this.status();
  }

  protected async runLogin(): Promise<void> {
    const browser = await launchVisibleBrowser();
    try {
      const context = await browser.newContext({
        locale: "fr-FR",
        viewport: SCREEN_VIEWPORT,
        // Start from the current session when there is one: if it's still
        // valid, there's nothing to do and the window closes right away.
        ...(existsSync(SESSION_PATH) ? { storageState: SESSION_PATH } : {}),
      });
      await blockThirdParty(context);
      const page = await context.newPage();
      this.screen.attach(page, "Connexion à Dealabs");
      await page.goto("https://www.dealabs.com/", {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });
      // Open the login dialog for you (best effort: if the button moved,
      // the page is still there to click it yourself).
      await page
        .getByText("Connexion ou inscription", { exact: false })
        .first()
        .click({ timeout: 5_000 })
        .catch(() => undefined);

      const deadline = Date.now() + LOGIN_TIMEOUT_MS;
      let loggedInChecks = 0;
      while (Date.now() < deadline) {
        if (page.isClosed()) {
          this.login = {
            ...this.login!,
            state: "cancelled",
            message: "Fenêtre fermée avant la connexion.",
          };
          return;
        }
        await page.waitForTimeout(POLL_MS);
        const loggedOut = await isDealabsLoggedOut(page).catch(() => true);
        const ready = await page
          .evaluate(() => document.readyState === "complete")
          .catch(() => false);
        // Two checks in a row: a page mid-navigation also briefly lacks
        // the login button.
        loggedInChecks = !loggedOut && ready ? loggedInChecks + 1 : 0;
        if (loggedInChecks >= 2) {
          await context.storageState({ path: SESSION_PATH });
          this.login = { ...this.login!, state: "saved" };
          return;
        }
      }
      this.login = {
        ...this.login!,
        state: "failed",
        message: "Délai dépassé (10 minutes) sans connexion.",
      };
    } finally {
      await browser.close().catch(() => undefined);
    }
  }
}
