// Compares Lightpanda (CDP) with headless Chromium on the pages our browser
// collectors read. Usage: lightpanda serve --port 9222 & node scripts/probe-lightpanda.mjs
import { chromium } from "playwright";

const WS = process.env.LIGHTPANDA_WS_URL ?? "ws://127.0.0.1:9222";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const PAGES = [
  [
    "amazon",
    "https://www.amazon.fr/deals",
    "[data-asin], [data-testid*='deal'], a[href*='/dp/']",
  ],
  [
    "amazon-bestsellers",
    "https://www.amazon.fr/gp/bestsellers/electronics",
    "[data-asin], a[href*='/dp/']",
  ],
  [
    "cdiscount",
    "https://www.cdiscount.com/informatique/ordinateurs-pc-portables/pc-portables/l-10709.html",
    "a[href*='/f-'], li[data-sku], [class*='prdtBlocInline']",
  ],
  [
    "aliexpress",
    "https://fr.aliexpress.com/gcp/300000512/nnmmu",
    "a[href*='/item/']",
  ],
  [
    "carrefour",
    "https://www.carrefour.fr/boutique/bons-plans-high-tech-maison",
    "a[href*='/p/']",
  ],
  [
    "sosh",
    "https://shop.sosh.fr/mobile/forfaits-mobiles",
    "[class*='price'], [class*='Price']",
  ],
  ["idealo", "https://www.idealo.fr/", "a[href]"],
];

async function run(label, browser, [name, url, selector]) {
  const context = await browser.newContext({ userAgent: UA, locale: "fr-FR" });
  const t0 = Date.now();
  try {
    const page = await context.newPage();
    const response = await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    await page.waitForTimeout(3000);
    const stats = await page.evaluate(
      (sel) => ({
        matches: document.querySelectorAll(sel).length,
        euros: (document.body?.innerText.match(/\d[\d\s.,]*\s?€/g) ?? [])
          .length,
        bytes: document.documentElement.outerHTML.length,
        blocked: /captcha|robot|access denied|verify you are/i.test(
          document.body?.innerText ?? "",
        ),
      }),
      selector,
    );
    return {
      name,
      engine: label,
      status: response?.status(),
      ms: Date.now() - t0,
      ...stats,
    };
  } catch (error) {
    return {
      name,
      engine: label,
      error: String(error.message).split("\n")[0],
      ms: Date.now() - t0,
    };
  } finally {
    await context.close().catch(() => {});
  }
}

const results = [];
const chrome = await chromium.launch({
  headless: true,
  args: ["--disable-gpu", "--disable-dev-shm-usage"],
});
for (const p of PAGES) results.push(await run("chromium", chrome, p));
await chrome.close();

for (const p of PAGES) {
  // A fresh CDP connection per page: Lightpanda handles one session at a time.
  let lp;
  try {
    lp = await chromium.connectOverCDP(WS);
    results.push(await run("lightpanda", lp, p));
  } catch (error) {
    results.push({
      name: p[0],
      engine: "lightpanda",
      error: String(error.message).split("\n")[0],
    });
  } finally {
    await lp?.close().catch(() => {});
  }
}
console.table(results);
