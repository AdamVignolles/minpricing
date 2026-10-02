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
    await waitForLaunchSlot();
    const browser = await launchCloudflareBrowser(puppeteer, cloudflareBinding);
    try {
      return await fn({ engine: "cloudflare", browser });
    } finally {
      await browser.close();
    }
  }

  // Dynamic import, not a static `import { chromium } from "playwright"` at
  // the top of the file: on Cloudflare Workers, a static import must resolve
  // to a real bundled module or the deploy is rejected outright ("No such
  // module... [code: 10021]"), even though this branch never runs there.
  // A dynamic `import()` is only resolved if actually awaited, so it never
  // trips that check on the `cloudflareBinding` path above.
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  try {
    return await fn({ engine: "playwright", browser });
  } finally {
    await browser.close();
  }
}

/**
 * Cloudflare's free Browser Rendering plan only allows one new browser to
 * be launched every 20s account-wide. The margin added on top of that is
 * deliberate: the 20s window is enforced server-side and starts from the
 * previous launch *attempt*, so cutting it exactly at 20s still raced to a
 * 429 in testing.
 */
const MIN_LAUNCH_INTERVAL_MS = 21_000;

/**
 * Timestamp (ms) of the last Cloudflare browser launch *attempt* made by
 * this isolate, successful or not. Cloudflare Workers routinely reuse the
 * same isolate across several invocations (e.g. consecutive cron ticks, or
 * `CollectionService.runAll()` calling into both Amazon's and Cdiscount's
 * `discover()` within the same request), so this module-level value is
 * what lets a *later* launch know to wait rather than just reacting to a
 * 429 after the fact. It resets to 0 on a fresh isolate, which is fine: an
 * isolate that has never launched a browser has nothing to wait for.
 */
let lastLaunchAttemptAt = 0;

/**
 * Blocks until at least {@link MIN_LAUNCH_INTERVAL_MS} has passed since the
 * last launch attempt *in this isolate*. Proactive, not just reactive: by
 * the time `CollectionService` moves from Amazon to Cdiscount, waiting
 * here avoids spending a launch attempt that was always going to 429.
 */
async function waitForLaunchSlot(): Promise<void> {
  const elapsed = Date.now() - lastLaunchAttemptAt;
  const remaining = MIN_LAUNCH_INTERVAL_MS - elapsed;
  if (remaining > 0) {
    await new Promise((resolve) => setTimeout(resolve, remaining));
  }
}

/**
 * Retrying after a 429 (with the same margin-of-safety delay) is a safety
 * net for launches this isolate didn't know about — another isolate, or
 * manual testing, using up the same account-wide window. A request that
 * fails for a real reason (bad binding, the 10min/day quota truly
 * exhausted) still surfaces after exhausting the retries.
 */
async function launchCloudflareBrowser(
  puppeteer: typeof import("@cloudflare/puppeteer").default,
  binding: CloudflareBrowserBinding,
  attempts = 3,
): Promise<import("@cloudflare/puppeteer").Browser> {
  for (let attempt = 1; ; attempt++) {
    lastLaunchAttemptAt = Date.now();
    try {
      return await puppeteer.launch(binding);
    } catch (error) {
      if (attempt >= attempts || !isRateLimitError(error)) {
        throw error;
      }
      await new Promise((resolve) =>
        setTimeout(resolve, MIN_LAUNCH_INTERVAL_MS),
      );
    }
  }
}

function isRateLimitError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("429") || /rate limit/i.test(message);
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

/**
 * Scrolls a listing page toward the bottom in viewport-sized steps,
 * re-extracting and accumulating matching elements after every step, and
 * stops early once scrolling further stops moving the page.
 *
 * This exists *instead of* a simpler "scroll to the bottom, then read the
 * DOM once" helper because Amazon's (and, to a lesser extent, Cdiscount's)
 * deal grid is virtualized: at any given moment the DOM only holds the
 * handful of cards near the current scroll position, older ones get
 * unmounted as new ones render in. Reading the DOM only once at the end
 * therefore only ever sees whichever batch happened to be mounted at the
 * final scroll position — measured in testing at just 5-10 cards — while
 * collecting after *every* step and merging by key surfaced 200+ distinct
 * cards on the same page. `scrollBy(window.innerHeight)` rather than one
 * `scrollTo(0, scrollHeight)` jump matters for the same reason: a big jump
 * skips past batches fast enough that their `IntersectionObserver` never
 * fires, which measured as *emptying* the grid (cards briefly go to 0)
 * instead of growing it.
 *
 * `rounds` is a ceiling, not a target: once a few consecutive steps fail
 * to move `scrollY` any further, the page has clearly finished loading
 * everything it ever will, and scrolling again would just burn time for
 * nothing — so a generous `rounds` default costs almost nothing on a
 * short list, while still giving a long one the room it needs to fully
 * unroll. Uses only the `evaluate` method already on {@link DealsPage}, so
 * it works identically on both the Playwright and Cloudflare engines.
 */
export async function scrollAndCollect<T>(
  page: DealsPage,
  extract: () => Promise<T[]>,
  keyOf: (item: T) => string | null | undefined,
  options: { rounds?: number; pauseMs?: number } = {},
): Promise<T[]> {
  const { rounds = 25, pauseMs = 700 } = options;
  const byKey = new Map<string, T>();
  let lastScrollY = -1;
  let unchangedStreak = 0;

  for (let i = 0; i < rounds; i++) {
    for (const item of await extract()) {
      const key = keyOf(item);
      if (key && !byKey.has(key)) {
        byKey.set(key, item);
      }
    }

    const scrollY = await page.evaluate(
      (ms) =>
        new Promise<number>((resolve) => {
          window.scrollBy(0, window.innerHeight);
          setTimeout(() => resolve(window.scrollY), ms);
        }),
      pauseMs,
    );

    if (scrollY <= lastScrollY) {
      unchangedStreak++;
      // 3, not 2: Amazon's grid briefly reports an unchanged/empty batch
      // between two virtualization windows while new cards are still
      // mounting — stopping on the first repeat cut the run short before
      // reaching the actual end in testing.
      if (unchangedStreak >= 3) {
        break;
      }
    } else {
      unchangedStreak = 0;
    }
    lastScrollY = scrollY;
  }

  // One last extraction: the final scroll step above may have mounted a
  // batch that was never read inside the loop.
  for (const item of await extract()) {
    const key = keyOf(item);
    if (key && !byKey.has(key)) {
      byKey.set(key, item);
    }
  }

  return Array.from(byKey.values());
}
