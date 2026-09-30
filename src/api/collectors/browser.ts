import { type Browser, chromium, type Page } from "playwright";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/**
 * Launches a throwaway headless Chromium instance, hands it to `fn`, and
 * always closes it afterwards (success or failure).
 *
 * A real browser is what lets us read Amazon/Cdiscount "deals" pages at
 * all: their listings are rendered client-side by JS, so a plain `fetch()`
 * sees an empty shell.
 */
export async function withBrowser<T>(
  fn: (browser: Browser) => Promise<T>,
): Promise<T> {
  const browser = await chromium.launch({ headless: true });
  try {
    return await fn(browser);
  } finally {
    await browser.close();
  }
}

/**
 * Opens one page in a brand new browser context (cookies/storage isolated
 * from any other call) and closes that context afterwards.
 *
 * Amazon in particular fingerprints sessions: a second page load reusing
 * the same context/cookies as a prior one comes back with key price
 * elements silently missing, even though the response is a normal 200 —
 * this only showed up in testing once several product pages were fetched
 * back-to-back. A fresh context per page makes every request look like an
 * independent first-time visitor, which reliably avoids it.
 */
export async function withPage<T>(
  browser: Browser,
  fn: (page: Page) => Promise<T>,
): Promise<T> {
  const context = await browser.newContext({
    userAgent: USER_AGENT,
    locale: "fr-FR",
  });
  try {
    await context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    });
    const page = await context.newPage();
    return await fn(page);
  } finally {
    await context.close();
  }
}

/**
 * Parses a French-formatted price string (e.g. "49,99 €", "1 299,00€") into
 * a plain number. Returns undefined if no price could be found.
 */
export function parsePriceFr(text: string): number | undefined {
  const match = text.replace(/\s/g, "").match(/(\d+(?:[.,]\d{1,2})?)/);

  if (!match) {
    return undefined;
  }

  return Number(match[1].replace(",", "."));
}
