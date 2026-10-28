import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { Alepha, $inject } from "alepha";
import type { Infer } from "alepha";
import { DateTimeProvider } from "alepha/datetime";
import { $logger } from "alepha/logger";

import type { dealabsDraftEntity } from "../entities/DealabsDraft.ts";
import { appDir } from "./appDir.ts";
import { dealabsTitle } from "./DealabsDraftService.ts";
import { isSameProduct } from "./dealabsSearch.ts";
import type { Deal } from "./DealTypes.ts";
import { keepaChartForDeal } from "./keepa.ts";
import {
  launchVisibleBrowser,
  RemoteScreenService,
  SCREEN_VIEWPORT,
  blockThirdParty,
} from "./RemoteScreenService.ts";

const LOGIN_WAIT_MS = 10 * 60_000;

/** A person can see the browser (local desktop, or the server's virtual display). */
const isAttended = () => process.platform !== "linux" || !!process.env.DISPLAY;

export const SESSION_PATH = join(appDir(), ".dealabs-session.json");
const DEBUG_DIR = join(appDir(), ".dealabs-debug");

/** "Essentiel" step fields, in lookup order. */
const TITLE_SELECTORS = [
  'input[name="title"]',
  'input[name="dealTitle"]',
  'input[placeholder*="itre" i]',
];
const PRICE_SELECTORS = [
  'input[name="price"]',
  'input[name="temp_price"]',
  'input[placeholder*="prix" i]',
];

type Draft = Infer<typeof dealabsDraftEntity.schema>;

/** A thread Dealabs' "Cette offre a-t-elle déjà été postée ?" panel lists. */
export interface DuplicateSuggestion {
  url: string;
  /** The item's visible text: title, often followed by price and merchant. */
  text: string;
}

/**
 * Which of Dealabs' suggested threads is really our product, if any.
 *
 * The panel lists *possible* duplicates — for a GOG link it suggested
 * Torchlight II for Prince of Persia. Erring on the safe side, a
 * suggestion counts as our product when it passes the app's product match
 * *or* shares most of our title's significant words (a URL slug loses
 * apostrophes and accents, which the strict match needs). The title comes
 * from the item's text, or from the URL slug when the text is empty.
 */
export function matchingDuplicate(
  ourTitle: string,
  ourPrice: number,
  suggestions: DuplicateSuggestion[],
): DuplicateSuggestion | undefined {
  const ours = significantWords(ourTitle);
  return suggestions.find((suggestion) => {
    const slug = suggestion.url
      .split("/")
      .pop()
      ?.replace(/-\d+$/, "")
      .replace(/-/g, " ");
    const title = suggestion.text.split("\n")[0]?.trim() || slug || "";
    const price = suggestion.text.match(/(\d+(?:[.,]\d{1,2})?)\s*€/);
    if (
      isSameProduct(ourTitle, ourPrice, {
        title,
        price: price ? Number(price[1].replace(",", ".")) : ourPrice,
      })
    ) {
      return true;
    }
    const theirs = significantWords(title);
    const shared = [...ours].filter((word) => theirs.has(word)).length;
    return ours.size > 0 && shared / ours.size >= 0.6;
  });
}

/** Title words that name the product: no shop, platform or filler words. */
const NOT_PRODUCT_WORDS = new Set([
  "pc",
  "gog",
  "steam",
  "epic",
  "sans",
  "drm",
  "sur",
  "pour",
  "avec",
  "les",
  "des",
  "the",
  "and",
  "edition",
  "version",
  "dematerialise",
  "jeu",
  "playstation",
  "store",
  "games",
  "nintendo",
  "switch",
  "xbox",
  "ps4",
  "ps5",
]);

function significantWords(title: string): Set<string> {
  return new Set(
    title
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/['’]/g, "")
      .split(/[^a-z0-9]+/)
      .map((word) =>
        word.length > 4 && word.endsWith("s") ? word.slice(0, -1) : word,
      )
      .filter((word) => word.length >= 3 && !NOT_PRODUCT_WORDS.has(word)),
  );
}

export interface AutoPublishResult {
  dealabsUrl: string;
}

/**
 * Thrown when this deal already looks like it's live on Dealabs — either a
 * search hit before we even open the form, or a warning Dealabs' own form
 * shows once the URL is pasted. Reposting an existing deal isn't allowed,
 * so this always aborts the run rather than submitting a duplicate.
 */
export class DealabsDuplicateError extends Error {
  constructor(
    message: string,
    public readonly existingUrl?: string,
  ) {
    super(message);
    this.name = "DealabsDuplicateError";
  }
}

/**
 * Drives a real, logged-in browser to submit a deal to Dealabs on your
 * behalf — login + fill + submit, no manual click.
 *
 * This only runs against a session you created yourself: the console's
 * « Se connecter à Dealabs » button (see `DealabsSessionService`, or the
 * older `npm run dealabs:login`) opens a visible browser for you to log in
 * by hand once, then saves cookies/local storage to `.dealabs-session.json`
 * (gitignored, never leaves this machine). This service only ever reuses
 * that file; it never sees or stores your Dealabs password.
 *
 * Local/bare-Node only — Playwright needs to spawn a real browser process
 * and a persisted session file, neither of which a stateless Cloudflare
 * Worker isolate can do. Deployed-to-Workers instances should keep using
 * the manual copy/open/verify flow; this is for the local dev server or a
 * bare Node deploy only.
 *
 * Selectors below are best-effort against Dealabs' current (as of writing)
 * submission form and may need adjusting if Dealabs changes their markup —
 * this is the one file to update if a run reports it couldn't find a field.
 */
export class DealabsPublisherService {
  protected log = $logger();
  protected alepha = $inject(Alepha);
  protected dateTime = $inject(DateTimeProvider);
  protected screen = $inject(RemoteScreenService);

  /**
   * @param chartImageUrl price-history picture for the top of the
   * description; Amazon deals get Keepa's when none is given.
   */
  async publish(
    deal: Deal,
    draft: Draft,
    chartImageUrl?: string,
  ): Promise<AutoPublishResult> {
    if (this.alepha.isServerless()) {
      throw new Error(
        "Auto-publish needs a real local browser session; it isn't available on the serverless deployment. Use the copy/paste flow there, or run the local dev server for auto-publish.",
      );
    }

    const hasSession = existsSync(SESSION_PATH);
    if (!hasSession && !isAttended()) {
      throw new Error(
        "Pas de session Dealabs : cliquez sur « Se connecter à Dealabs », connectez-vous dans la fenêtre qui s'ouvre, puis réessayez.",
      );
    }

    // Cheap check first, no browser needed: if a Dealabs thread for this
    // exact product link already exists, don't even bother opening one —
    // reposting the same deal isn't allowed.
    const existingUrl = await this.findExistingPost(deal);
    if (existingUrl) {
      throw new DealabsDuplicateError(
        `Ce deal semble déjà publié sur Dealabs : ${existingUrl}`,
        existingUrl,
      );
    }

    // Headless was silently caught by Dealabs' Cloudflare bot-check (a
    // "prove you're human" checkbox) even with a valid logged-in session —
    // this project also never tries to bypass anti-bot/CAPTCHA, so instead
    // of fighting it we run a real, visible browser. If Cloudflare still
    // challenges it, you see the window and click the checkbox yourself,
    // same as during `npm run dealabs:login`.
    const browser = await launchVisibleBrowser();

    try {
      const context = await browser.newContext({
        ...(hasSession ? { storageState: SESSION_PATH } : {}),
        locale: "fr-FR",
        viewport: SCREEN_VIEWPORT,
      });
      await blockThirdParty(context);
      const page = await context.newPage();
      this.screen.attach(page, "Publication sur Dealabs");

      try {
        await page.goto("https://www.dealabs.com/bons-plans", {
          waitUntil: "domcontentloaded",
          timeout: 30_000,
        });

        await this.waitOutCloudflareChallenge(page);

        if (await this.isLoggedOut(page)) {
          await this.waitForLogin(page);
          await context.storageState({ path: SESSION_PATH });
        }

        await this.openSubmissionForm(page);
        const dealabsUrl = await this.fillFormAndSubmit(
          page,
          deal,
          draft,
          chartImageUrl ?? keepaChartForDeal(deal),
        );

        // Refresh the saved session: Dealabs may rotate cookies on use, and
        // keeping the file current avoids forcing a re-login sooner than
        // necessary.
        await context.storageState({ path: SESSION_PATH });

        return { dealabsUrl };
      } catch (error) {
        if (error instanceof DealabsDuplicateError) {
          throw error;
        }
        const debugPath = await this.captureDebug(page, deal.id);
        throw new Error(
          `${error instanceof Error ? error.message : String(error)} (debug snapshot: ${debugPath})`,
        );
      }
    } finally {
      await browser.close();
    }
  }

  /**
   * Pre-flight, no-browser duplicate check: searches Dealabs for the
   * product title and looks for a result whose embedded link matches this
   * deal's URL. Best-effort string matching (same "normalize + includes"
   * approach as `verify`'s own check) rather than a parsed DOM, since
   * search-result markup is as likely to shift as the submission form's.
   * Returns the matching Dealabs thread URL, or undefined if nothing
   * looks like a match.
   */
  protected async findExistingPost(deal: Deal): Promise<string | undefined> {
    try {
      const response = await fetch(
        `https://www.dealabs.com/search?q=${encodeURIComponent(deal.title)}`,
        {
          headers: { "user-agent": "Mozilla/5.0 (DealRadar duplicate check)" },
        },
      );
      if (!response.ok) {
        return undefined;
      }

      const html = await response.text();
      if (!html.includes(deal.url)) {
        return undefined;
      }

      // The deal's own link is in there somewhere; grab the nearest
      // Dealabs thread link before it as the "existing post" to point at.
      const index = html.indexOf(deal.url);
      const before = html.slice(Math.max(0, index - 2000), index);
      const match = [
        ...before.matchAll(
          /https:\/\/www\.dealabs\.com\/bons-plans\/[^"'\s]+/g,
        ),
      ].pop();
      return match?.[0];
    } catch {
      // A failed pre-check shouldn't block publishing outright — the
      // in-form warning below is the second line of defence.
      return undefined;
    }
  }

  /**
   * Dealabs puts an interactive challenge (Cloudflare Turnstile checkbox)
   * in front of some navigations even with a valid session. Since this
   * project never tries to defeat anti-bot/CAPTCHA, this just waits —
   * with the browser visible, you click the checkbox yourself and the
   * run continues on its own once the challenge page is gone.
   */
  protected async waitOutCloudflareChallenge(
    page: import("playwright").Page,
  ): Promise<void> {
    const isChallenge = async () =>
      (await page
        .getByText(/vérification que vous n'êtes pas un robot/i)
        .count()) > 0;

    if (!(await isChallenge())) {
      return;
    }

    // Without any display nobody can click the checkbox (the console's
    // « écran distant » needs the server's virtual display, DISPLAY=:99):
    // don't make the console wait minutes for nothing.
    if (!isAttended()) {
      await page.waitForTimeout(10_000);
      if (!(await isChallenge())) {
        return;
      }
      throw new Error(
        "Dealabs demande une vérification anti-robot (Cloudflare) que le serveur ne peut pas valider : publiez depuis un poste local (npm run dev + « Se connecter à Dealabs ») ou copiez le brouillon à la main.",
      );
    }

    const deadline = Date.now() + 240_000;
    while ((await isChallenge()) && Date.now() < deadline) {
      await page.waitForTimeout(1_000);
    }

    if (await isChallenge()) {
      throw new Error(
        "Cloudflare challenge was not cleared in time — resolve it in the browser window and try again.",
      );
    }
  }

  /**
   * Playwright's selectors below are a best-effort read of Dealabs'
   * current markup — a hand-rolled JS framework, not React/Vue, so most
   * controls are plain `<div>`s with no ARIA role rather than real
   * `<button>`/`<a>` elements. When a run fails, this saves a screenshot
   * + the page's HTML next to `.dealabs-session.json` so you (or a future
   * fix here) can see exactly what the page looked like at the point of
   * failure, instead of just a timeout message.
   */
  protected async captureDebug(
    page: import("playwright").Page,
    dealId: string,
  ): Promise<string> {
    try {
      mkdirSync(DEBUG_DIR, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const base = join(DEBUG_DIR, `${stamp}-${dealId}`);
      await page.screenshot({ path: `${base}.png`, fullPage: true });
      writeFileSync(`${base}.html`, await page.content());
      return `${base}.png`;
    } catch {
      return "(failed to capture debug snapshot)";
    }
  }

  /**
   * Session missing or expired: rather than failing and making you start a
   * separate login, open Dealabs' login dialog in this same window (shown
   * in the console's « écran distant ») and carry on with the publication
   * once you've logged in. Never fills credentials itself.
   */
  protected async waitForLogin(page: import("playwright").Page): Promise<void> {
    if (!isAttended()) {
      throw new Error(
        "La session Dealabs a expiré : cliquez sur « Se connecter à Dealabs » pour vous reconnecter.",
      );
    }
    this.screen.attach(page, "Connectez-vous à Dealabs pour publier");
    await page
      .getByText("Continuer sans accepter", { exact: false })
      .first()
      .click({ timeout: 3_000 })
      .catch(() => undefined);
    await page
      .getByText("Connexion ou inscription", { exact: false })
      .first()
      .click({ timeout: 5_000 })
      .catch(() => undefined);

    const deadline = Date.now() + LOGIN_WAIT_MS;
    let loggedInChecks = 0;
    while (Date.now() < deadline) {
      await page.waitForTimeout(2_000);
      const loggedOut = await this.isLoggedOut(page).catch(() => true);
      const ready = await page
        .evaluate(() => document.readyState === "complete")
        .catch(() => false);
      // Two checks in a row: a page mid-navigation also briefly lacks the
      // login button.
      loggedInChecks = !loggedOut && ready ? loggedInChecks + 1 : 0;
      if (loggedInChecks >= 2) {
        this.screen.attach(page, "Publication sur Dealabs");
        return;
      }
    }
    throw new Error(
      "Connexion à Dealabs non faite dans les 10 minutes : relancez la publication automatique et connectez-vous dans l'écran distant.",
    );
  }

  protected isLoggedOut(page: import("playwright").Page): Promise<boolean> {
    return isDealabsLoggedOut(page);
  }

  /**
   * `/submission/add` turns out to be an intermediate "what do you want
   * to post?" chooser (Deal / Code promo / Discussion / Offre de
   * parrainage), not the form itself — confirmed from a captured page.
   * `/submission/bons-plans/add` is the direct deal-submission form.
   */
  protected async openSubmissionForm(
    page: import("playwright").Page,
  ): Promise<void> {
    await page.goto(
      "https://www.dealabs.com/submission/bons-plans/add?thread_created_location=thread_type_selection",
      {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      },
    );
    await this.waitOutCloudflareChallenge(page);
    await page.waitForSelector('input[name="link"], #link', {
      timeout: 15_000,
    });
  }

  /**
   * Dealabs' submission form is a single-page, multi-step wizard with a
   * sidebar: "Lien", "Essentiel" (title/price), "Galerie d'images",
   * "Description", "Derniers détails", "Vérification" — confirmed from a
   * real captured run. Each step's fields only exist in the DOM once that
   * step is active, so fields must be filled *and then advance* one step
   * at a time, not all up front — filling "Description" before reaching
   * that step just silently finds nothing there.
   */
  protected async fillFormAndSubmit(
    page: import("playwright").Page,
    deal: Deal,
    draft: Draft,
    chart?: string,
  ): Promise<string> {
    // Step: Lien
    const linkInput = page.locator('input[name="link"], #link').first();
    await linkInput.fill(deal.url);

    const continueWithLink = page
      .locator('[data-t="submitWithLink"]')
      .or(page.getByText("Continuer", { exact: true }))
      .first();
    await continueWithLink.click({ timeout: 15_000 });

    // Dealabs auto-fetches title/image/price from the link and this is
    // also when it would warn about a duplicate thread. That fetch takes a
    // variable few seconds, during which the "Essentiel" panel is blank: a
    // fixed pause was sometimes too short and the title field didn't exist
    // yet (captured: empty panel). Wait for whichever shows up first — the
    // step's fields or the duplicate warning.
    await this.waitForAny(
      page,
      [...TITLE_SELECTORS, ...PRICE_SELECTORS, '[data-t="threadDuplicates"]'],
      30_000,
    );
    await this.handleDuplicateWarning(page, deal);

    // Step: Essentiel — Dealabs usually auto-fills title/price from the
    // link already; we overwrite with our own values to make sure they
    // match the draft exactly. Each of these is `required: true`: if the
    // value doesn't actually stick, that's exactly the "looks finished
    // but a field is wrong/empty" failure mode — better to abort loudly
    // here than post something incomplete.
    // A title edited by hand may exceed Dealabs' limit: fit it here too.
    await this.fillFirstMatch(
      page,
      TITLE_SELECTORS,
      dealabsTitle(draft.title),
      {
        clearFirst: true,
        byLabel: /titre/i,
        required: true,
        fieldName: "Titre",
      },
    );

    await this.fillFirstMatch(
      page,
      PRICE_SELECTORS,
      deal.currentPrice.toFixed(2),
      {
        clearFirst: true,
        byLabel: /^prix$/i,
        required: true,
        fieldName: "Prix",
      },
    );

    if (deal.listPrice) {
      await this.fillFirstMatch(
        page,
        ['input[name="nextBestPrice"]', 'input[name="old_price"]'],
        deal.listPrice.toFixed(2),
        {
          clearFirst: true,
          byLabel: /prix.*constat/i,
          required: true,
          fieldName: "Prix constaté ailleurs",
        },
      );
    }

    await this.clickNavNext(page);

    // Step: Galerie d'images — optional, nothing to fill.
    await this.clickNavNext(page);

    // Step: Description — a Tiptap/ProseMirror rich-text editor, not a
    // plain `<textarea>` (confirmed from a captured page): a `div`
    // with `contenteditable="true"` and `role="textbox"`. Playwright's
    // `.fill()` supports contenteditable elements directly.
    await this.fillFirstMatch(
      page,
      [
        '[role="textbox"][contenteditable="true"]',
        ".ProseMirror",
        'textarea[name="description"]',
        "textarea",
      ],
      draft.description?.trim() || draft.body,
      {
        clearFirst: true,
        byLabel: /description/i,
        required: true,
        fieldName: "Description",
      },
    );
    // Price-history chart at the top of the text: Keepa for Amazon,
    // the eShop history (QuickChart) for Nintendo — see `publish()`.
    if (chart) {
      await this.insertImageAtTop(page, chart);
    }
    await this.clickNavNext(page);

    // Step: Derniers détails — native `type="date"` inputs named
    // `startDate`/`endDate` (confirmed from a captured page), plus an
    // auto-picked category we leave alone. No real availability window
    // is tracked for most deals, so default to "now" → "a week from now"
    // rather than leaving it blank.
    const start = deal.startDate
      ? this.dateTime.of(deal.startDate)
      : this.dateTime.now();
    const end = deal.endDate
      ? this.dateTime.of(deal.endDate)
      : start.add(7, "day");

    await this.fillFirstMatch(
      page,
      ['input[name="startDate"]'],
      start.format("YYYY-MM-DD"),
      {
        required: true,
        fieldName: "Date de début",
      },
    );
    await this.fillFirstMatch(
      page,
      ['input[name="endDate"]'],
      end.format("YYYY-MM-DD"),
      {
        required: true,
        fieldName: "Date de fin",
      },
    );

    // Step: Vérification / final submit — same physical button as
    // "Suivant" throughout the wizard, just relabeled "Poster un deal"
    // once every step is complete (confirmed from a captured page:
    // `[data-t="navNext"]`, `type="submit"`).
    await this.clickNavNext(page);

    await page
      .waitForURL(/dealabs\.com\/bons-plans\/[^/]+$/, { timeout: 30_000 })
      .catch(() => undefined);

    return page.url();
  }

  /**
   * Dealabs reuses one physical button throughout the wizard
   * (`[data-t="navNext"]`) for every "Suivant" step and the final
   * "Poster un deal" submit — only its label changes depending on where
   * you are. A role-based text match isn't needed once you know this.
   *
   * A failed click here used to be swallowed silently (`.catch(() =>
   * undefined)`), which is exactly how a stuck step went unnoticed: if
   * Dealabs' own client-side validation disables the button (e.g. because
   * a field it still considers empty wasn't actually filled), the click
   * just does nothing and the run barrels on to the next step's fields
   * — which don't exist yet because the wizard never advanced. Letting
   * the click's own timeout error propagate turns that into a clear
   * failure instead of a silent no-op.
   */
  /**
   * Puts an image (by URL) at the top of the description editor, centred:
   * the editor's « Image » button opens « Insérer une image » with an
   * « Image depuis une URL » field (confirmed on a captured page; Dealabs
   * then re-hosts the picture on its own CDN). Best-effort: a deal is
   * still worth publishing without its chart, so any failure here is
   * logged and the publish goes on.
   */
  protected async insertImageAtTop(
    page: import("playwright").Page,
    imageUrl: string,
  ): Promise<void> {
    try {
      const editor = page
        .locator('[role="textbox"][contenteditable="true"]')
        .first();
      const before = await editor.locator("img").count();
      await editor.click();
      await page.keyboard.press("Control+Home");
      await editor
        .locator("xpath=../../..")
        .locator('button[aria-label="Image"]')
        .first()
        .click({ timeout: 5_000 });
      await page
        .getByPlaceholder(/URL de l.image/i)
        .first()
        .fill(imageUrl, { timeout: 5_000 });
      await page
        .getByRole("button", { name: /centrer/i })
        .first()
        .click({ timeout: 3_000 })
        .catch(() => undefined);
      await page
        .getByRole("button", { name: /^ajouter$/i })
        .first()
        .click({ timeout: 5_000 });
      // Dealabs downloads and re-hosts the image before showing it.
      await editor.locator("img").nth(before).waitFor({ timeout: 15_000 });
    } catch (error) {
      this.log.warn("Price chart not added to the Dealabs description", {
        error: error instanceof Error ? error.message : String(error),
      });
      // Leave the dialog closed so the next step can proceed.
      await page.keyboard.press("Escape").catch(() => undefined);
    }
  }

  protected async clickNavNext(page: import("playwright").Page): Promise<void> {
    const next = page.locator('[data-t="navNext"]').first();
    if ((await next.count()) === 0) {
      return;
    }
    try {
      await next.click({ timeout: 10_000 });
    } catch (error) {
      // A click that triggers a real page navigation (the final "Poster un
      // deal" submit) can race Playwright's own execution context and
      // throw even though the click itself landed — a known, benign
      // Playwright gotcha, not a stuck step. Anything else (timeout
      // because the button is disabled/covered, element not found) is a
      // genuine failure and must not be swallowed.
      const message = error instanceof Error ? error.message : String(error);
      if (
        !/execution context was destroyed|frame.*detached|navigation/i.test(
          message,
        )
      ) {
        throw error;
      }
    }
    await page.waitForTimeout(1_000);
  }

  /**
   * Confirmed exact markup from a real captured duplicate: Dealabs shows
   * a `[data-t="threadDuplicates"]` panel titled "Cette offre a-t-elle
   * déjà été postée ?", with the suggested threads linked via
   * `[data-t="threadDuplicatesItem"]` and a "Oui, annuler" button
   * (`[data-t="cancel"]`).
   *
   * The suggestions are only *possible* duplicates (other deals of the
   * same shop show up), so we stop only when one is really our product
   * ({@link matchingDuplicate}); otherwise we answer "no" and carry on.
   * If that "no" button can't be found, the page is captured and we stop
   * as before — never guess a click on a form we can't read.
   */
  protected async handleDuplicateWarning(
    page: import("playwright").Page,
    deal: Deal,
  ): Promise<void> {
    const panel = page.locator('[data-t="threadDuplicates"]');
    if ((await panel.count()) === 0) {
      return;
    }

    const items = panel.locator('[data-t="threadDuplicatesItem"]');
    const suggestions: DuplicateSuggestion[] = [];
    for (let index = 0; index < (await items.count()); index++) {
      const item = items.nth(index);
      suggestions.push({
        url: (await item.getAttribute("href")) ?? "",
        text: (await item.innerText().catch(() => "")) ?? "",
      });
    }

    const match = matchingDuplicate(deal.title, deal.currentPrice, suggestions);
    if (match || suggestions.length === 0) {
      throw new DealabsDuplicateError(
        "Dealabs signale que ce deal existe déjà.",
        (match ?? suggestions[0])?.url || undefined,
      );
    }

    const notDuplicate = panel
      .locator(
        '[data-t="continue"], [data-t="confirm"], [data-t="notDuplicate"], [data-t="submit"]',
      )
      .or(
        panel.getByRole("button", {
          name: /^non\b|continuer|poster|publier|pas un doublon/i,
        }),
      )
      .first();
    if ((await notDuplicate.count()) === 0) {
      const debugPath = await this.captureDebug(page, deal.id);
      throw new DealabsDuplicateError(
        `Dealabs propose des doublons possibles (${suggestions.map((s) => s.url).join(", ")}) qui ne sont pas ce produit, mais le bouton pour continuer est introuvable (debug snapshot: ${debugPath})`,
        suggestions[0]?.url || undefined,
      );
    }
    this.log.info(
      "Dealabs duplicate suggestions are other products, continuing",
      {
        dealId: deal.id,
        suggestions: suggestions.map((suggestion) => suggestion.url),
      },
    );
    await notDuplicate.click({ timeout: 10_000 });
    await this.waitForAny(
      page,
      [...TITLE_SELECTORS, ...PRICE_SELECTORS],
      20_000,
    );
  }

  /**
   * Resolves once any of `selectors` (or a field labelled `byLabel`) is
   * visible, or after `timeoutMs` — never throws: the caller's own lookup
   * then reports precisely what's missing.
   */
  protected async waitForAny(
    page: import("playwright").Page,
    selectors: string[],
    timeoutMs: number,
    byLabel?: RegExp,
  ): Promise<void> {
    let target = page.locator(selectors.join(", "));
    if (byLabel) {
      target = target.or(page.getByLabel(byLabel));
    }
    await target
      .first()
      .waitFor({ state: "visible", timeout: timeoutMs })
      .catch(() => undefined);
  }

  protected async fillFirstMatch(
    page: import("playwright").Page,
    selectors: string[],
    value: string,
    options?: {
      clearFirst?: boolean;
      byLabel?: RegExp;
      required?: boolean;
      fieldName?: string;
    },
  ): Promise<boolean> {
    // Nothing to type is our problem, not a changed Dealabs form: say so.
    if (options?.required && !value.trim()) {
      throw new Error(
        `Le champ "${options.fieldName ?? "?"}" est vide dans le brouillon : rien à saisir sur Dealabs.`,
      );
    }

    // Each wizard step renders its fields a moment after the previous
    // "Suivant" click: give a required field time to appear instead of
    // declaring it missing on the first look.
    if (options?.required) {
      await this.waitForAny(page, selectors, 15_000, options.byLabel);
    }

    for (const selector of selectors) {
      const locator = page.locator(selector).first();
      if ((await locator.count()) === 0) {
        continue;
      }
      if (await this.fillAndVerify(locator, value, options?.clearFirst)) {
        return true;
      }
    }

    // Selector guesses all missed — try matching by visible label text,
    // which survives attribute-name changes better than a guessed `name`.
    if (options?.byLabel) {
      const byLabel = page.getByLabel(options.byLabel).first();
      if (
        (await byLabel.count()) > 0 &&
        (await this.fillAndVerify(byLabel, value, options.clearFirst))
      ) {
        return true;
      }
    }

    if (options?.required) {
      throw new Error(
        `Impossible de remplir le champ "${options.fieldName ?? value}" — aucun des sélecteurs connus n'a été trouvé, ou la valeur ne s'est pas enregistrée. Le formulaire Dealabs a probablement changé.`,
      );
    }

    return false;
  }

  /**
   * Fills a locator (plain input or contenteditable) and reads the value
   * straight back to confirm it actually stuck — some of Dealabs' fields
   * are backed by JS that can silently reset/ignore a programmatic
   * `.fill()`, or already hold a stale auto-filled value from before our
   * own write runs (e.g. Dealabs itself pre-fills title/price from the
   * pasted link). Without this check, a selector that technically exists
   * but didn't actually accept *our* value looked exactly like success:
   * the wizard happily moved on to the next step with the old/empty value
   * still in place.
   */
  protected async fillAndVerify(
    locator: import("playwright").Locator,
    value: string,
    clearFirst?: boolean,
  ): Promise<boolean> {
    try {
      if (clearFirst) {
        await locator.fill("");
      }
      await locator.fill(value);
    } catch {
      // Not a fillable text input (e.g. a contenteditable rejecting
      // `.fill()` in some edge case) — treat as "didn't take" rather than
      // blowing up the whole run; the caller tries the next selector.
      return false;
    }

    const actual = await locator
      .inputValue()
      .catch(() => locator.textContent().catch(() => null));

    if (typeof actual !== "string" || actual.trim().length === 0) {
      return false;
    }

    return DealabsPublisherService.valuesMatch(actual, value);
  }

  /**
   * Loose equality between what we asked to type and what's actually in
   * the field: an exact string match once whitespace-normalized, or —
   * since price/date fields routinely get reformatted on blur (comma vs.
   * dot decimals, an added currency symbol, zero-padding) — a numeric
   * match when both sides parse as a number.
   */
  protected static valuesMatch(actual: string, expected: string): boolean {
    const normalize = (s: string) =>
      s.replace(/\s+/g, " ").trim().toLowerCase();
    if (normalize(actual) === normalize(expected)) {
      return true;
    }
    // A rich-text editor's `textContent` drops the line breaks between its
    // paragraphs ("encore.- RÉVEIL" for "encore." + blank line + "- RÉVEIL"):
    // compare the text itself, whitespace aside.
    const compact = (s: string) => s.replace(/\s+/g, "").toLowerCase();
    if (compact(expected).length > 0 && compact(actual) === compact(expected)) {
      return true;
    }

    const toNumber = (s: string) => {
      const match = s.replace(/\s/g, "").match(/-?\d+(?:[.,]\d+)?/);
      return match ? Number(match[0].replace(",", ".")) : undefined;
    };
    const actualNumber = toNumber(actual);
    const expectedNumber = toNumber(expected);

    return (
      actualNumber !== undefined &&
      expectedNumber !== undefined &&
      Math.abs(actualNumber - expectedNumber) < 0.01
    );
  }

  protected async submit(page: import("playwright").Page): Promise<string> {
    // Same custom-framework caveat as the "Poster" trigger: try the
    // semantic route first (a real `<button>`), then fall back to any
    // element matching the text, since Dealabs' submit control may well
    // be a styled `<div>`/`<span>` too.
    const byRole = page.getByRole("button", {
      name: /publier|soumettre|envoyer/i,
    });
    const target =
      (await byRole.count()) > 0
        ? byRole.first()
        : page.getByText(/publier|soumettre|envoyer/i).first();

    await target.click({ timeout: 15_000 });
    await page.waitForURL(/dealabs\.com\/.+/, { timeout: 30_000 });
    return page.url();
  }
}

/** Dealabs shows "Connexion ou inscription" only to logged-out visitors. */
export async function isDealabsLoggedOut(
  page: import("playwright").Page,
): Promise<boolean> {
  const loginButton = page.getByText("Connexion ou inscription", {
    exact: false,
  });
  return (await loginButton.count()) > 0;
}
