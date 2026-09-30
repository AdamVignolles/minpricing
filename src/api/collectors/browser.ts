import { chromium } from "playwright";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/**
 * The minimal page surface collectors actually use, shared between the two
 * engines below (Playwright locally, `@cloudflare/puppeteer` on Workers).
 * Both libraries implement this shape closely enough (same method names,
 * same `HTTPResponse`-like `.ok()`/`.status()`) that collectors never need
 * to know which one is behind it.
 */
export interface DealsPage {
  goto(
    url: string,
    options: {
      waitUntil: "domcontentloaded" | "networkidle";
      timeout: number;
    },
  ): Promise<{ ok(): boolean; status(): number } | null>;
  waitForSelector(
    selector: string,
    options: { timeout: number },
  ): Promise<unknown>;
  evaluate<T, A>(fn: (arg: A) => T, arg?: A): Promise<T>;
}

/**
 * Opaque handle returned by {@link withBrowser}. Only ever passed back into
 * {@link withPage} — collectors never touch its internals.
 */
export type DealsBrowserHandle =
  | { engine: "playwright"; browser: import("playwright").Browser }
  | { engine: "cloudflare"; browser: import("@cloudflare/puppeteer").Browser };

/**
 * A Cloudflare Workers "Browser Rendering" binding (the `env.BROWSER` object
 * a Worker gets when its `wrangler.jsonc` declares a `browser` binding).
 * Passed in only when running on Workers — see `CollectionService`, which
 * reads it from `alepha.get("cloudflare.env")` when `alepha.isServerless()`.
 */
export type CloudflareBrowserBinding =
  import("@cloudflare/puppeteer").BrowserWorker;

/**
 * Launches a throwaway headless browser, hands it to `fn`, and always
 * closes it afterwards (success or failure).
 *
 * A real browser is what lets us read Amazon/Cdiscount "deals" pages at
 * all: their listings are rendered client-side by JS, so a plain `fetch()`
 * sees an empty shell.
 *
 * Locally / on a plain Node server this launches a local headless Chromium
 * via Playwright. On Cloudflare Workers (no process spawning allowed) it
 * instead acquires a remote browser through the Workers "Browser
 * Rendering" binding via `@cloudflare/puppeteer` — pass that binding as
 * `cloudflareBinding` (omit it, or leave it `undefined`, everywhere else).
 */
export async function withBrowser<T>(
  fn: (browser: DealsBrowserHandle) => Promise<T>,
  cloudflareBinding?: CloudflareBrowserBinding,
): Promise<T> {
  if (cloudflareBinding) {
    const { default: puppeteer } = await import("@cloudflare/puppeteer");
    const browser = await puppeteer.launch(cloudflareBinding);
    try {
      return await fn({ engine: "cloudflare", browser });
    } finally {
      await browser.close();
    }
  }

  const browser = await chromium.launch({ headless: true });
  try {
    return await fn({ engine: "playwright", browser });
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
  handle: DealsBrowserHandle,
  fn: (page: DealsPage) => Promise<T>,
): Promise<T> {
  if (handle.engine === "cloudflare") {
    const context = await handle.browser.createBrowserContext();
    try {
      const page = await context.newPage();
      await page.setUserAgent(USER_AGENT);
      await page.setExtraHTTPHeaders({ "Accept-Language": "fr-FR,fr;q=0.9" });
      await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, "webdriver", { get: () => undefined });
      });
      return await fn(adaptCloudflarePage(page));
    } finally {
      await context.close();
    }
  }

  const context = await handle.browser.newContext({
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
 * Adapts a `@cloudflare/puppeteer` `Page` to {@link DealsPage}: identical in
 * every respect used here except `waitUntil: "networkidle"`, which
 * Puppeteer spells `"networkidle0"`.
 */
function adaptCloudflarePage(
  page: import("@cloudflare/puppeteer").Page,
): DealsPage {
  return {
    goto: (url, options) =>
      page.goto(url, {
        timeout: options.timeout,
        waitUntil:
          options.waitUntil === "networkidle"
            ? "networkidle0"
            : options.waitUntil,
      }),
    waitForSelector: (selector, options) =>
      page.waitForSelector(selector, options),
    evaluate: (fn, arg) => page.evaluate(fn, arg as never),
  };
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
