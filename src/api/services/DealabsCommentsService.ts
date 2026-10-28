import { $inject, Alepha } from "alepha";

import { withBrowser, withPage } from "../collectors/browser.ts";

/** Only our own Dealabs threads are read: never an arbitrary URL. */
export const isDealabsThreadUrl = (url: string): boolean => {
  try {
    const u = new URL(url);
    return (
      u.protocol === "https:" &&
      u.hostname === "www.dealabs.com" &&
      /^\/(bons-plans|codes-promo|gratuit|discussions)\//.test(u.pathname)
    );
  } catch {
    return false;
  }
};

/**
 * Comment texts as scraped (a parent element repeats its children): keeps
 * the innermost ones, deduplicated, the first 6, 220 characters each.
 */
export function commentLeaves(texts: string[]): string[] {
  const unique = [...new Set(texts.filter(Boolean))];
  return unique
    .filter((t) => !unique.some((o) => o !== t && t.includes(o)))
    .slice(0, 6)
    .map((t) => t.slice(0, 220));
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/**
 * The first comments of our Dealabs threads, read in the server's headless
 * browser (Dealabs' API refuses scripts). For the evening debrief run as a
 * cloud routine, which has no browser (`POST /agent/dealabs-comments`).
 */
export class DealabsCommentsService {
  protected alepha = $inject(Alepha);

  async read(urls: string[]): Promise<Record<string, string[]>> {
    if (this.alepha.isServerless()) {
      throw new Error("no browser on the serverless deployment");
    }
    const out: Record<string, string[]> = {};
    await withBrowser(async (browser) => {
      for (const url of urls) {
        try {
          out[url] = await withPage(browser, async (page) => {
            await page.goto(url, {
              waitUntil: "domcontentloaded",
              timeout: 45_000,
            });
            await sleep(5000);
            await page.evaluate(() =>
              window.scrollTo(0, document.body.scrollHeight),
            );
            await sleep(3000);
            const texts = await page.evaluate(() =>
              [
                ...document.querySelectorAll<HTMLElement>(
                  '[class*="comment-body"], .commentList-item, article[id^="comment"]',
                ),
              ].map((el) => el.innerText.replace(/\s+/g, " ").trim()),
            );
            return commentLeaves(texts);
          });
        } catch {
          out[url] = [];
        }
        await sleep(2000);
      }
    });
    return out;
  }
}
