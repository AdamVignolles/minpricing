import { $hook, $inject, Alepha } from "alepha";
import { $logger } from "alepha/logger";

import { ensureBrowsers } from "../collectors/browserInstall.ts";

/**
 * At startup, makes sure Playwright's Chromium builds are installed
 * (`browserInstall.ts`), in the background: the server answers at once,
 * and a collection or publication starting meanwhile waits for the
 * install. Skipped on Workers (no local browser there).
 */
export class BrowserInstallService {
  protected alepha = $inject(Alepha);
  protected log = $logger();

  onReady = $hook({
    on: "ready",
    handler: () => {
      if (this.alepha.isServerless() || this.alepha.isTest()) return;
      void ensureBrowsers().then((state) => {
        if (state.state === "ready") {
          this.log.info("Browsers: Chromium builds installed and ready");
        } else {
          this.log.error(`Browsers: install failed — ${state.detail}`);
        }
      });
    },
  });
}
