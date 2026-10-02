import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { Alepha, $inject } from "alepha";
import type { Infer } from "alepha";
import { DateTimeProvider } from "alepha/datetime";

import type { dealabsDraftEntity } from "../entities/DealabsDraft.ts";
import type { Deal } from "./DealTypes.ts";

const SESSION_PATH = join(process.cwd(), ".dealabs-session.json");
const DEBUG_DIR = join(process.cwd(), ".dealabs-debug");

type Draft = Infer<typeof dealabsDraftEntity.schema>;

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
 * This only runs against a session you created yourself:
 * `npm run dealabs:login` opens a visible browser for you to log in by
 * hand once, then saves cookies/local storage to `.dealabs-session.json`
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
  protected alepha = $inject(Alepha);
  protected dateTime = $inject(DateTimeProvider);

  async publish(deal: Deal, draft: Draft): Promise<AutoPublishResult> {
    if (this.alepha.isServerless()) {
      throw new Error(
        "Auto-publish needs a real local browser session; it isn't available on the serverless deployment. Use the copy/paste flow there, or run the local dev server for auto-publish.",
      );
    }

    if (!existsSync(SESSION_PATH)) {
      throw new Error(
        'No Dealabs session found. Run "npm run dealabs:login" once to log in, then try again.',
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

    const { chromium } = await import("playwright");
    // Headless was silently caught by Dealabs' Cloudflare bot-check (a
    // "prove you're human" checkbox) even with a valid logged-in session —
    // this project also never tries to bypass anti-bot/CAPTCHA, so instead
    // of fighting it we run a real, visible browser. If Cloudflare still
    // challenges it, you see the window and click the checkbox yourself,
    // same as during `npm run dealabs:login`.
    const browser = await chromium.launch({ headless: false });

    try {
      const context = await browser.newContext({
        storageState: SESSION_PATH,
        locale: "fr-FR",
      });
      const page = await context.newPage();

      try {
        await page.goto("https://www.dealabs.com/bons-plans", {
          waitUntil: "domcontentloaded",
          timeout: 30_000,
        });

        await this.waitOutCloudflareChallenge(page);

        if (await this.isLoggedOut(page)) {
          throw new Error(
            'Dealabs session has expired. Run "npm run dealabs:login" again.',
          );
        }

        await this.openSubmissionForm(page);
        const dealabsUrl = await this.fillFormAndSubmit(page, deal, draft);

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

    const deadline = Date.now() + 120_000;
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

  protected async isLoggedOut(
    page: import("playwright").Page,
  ): Promise<boolean> {
    const loginButton = page.getByText("Connexion ou inscription", {
      exact: false,
    });
    return (await loginButton.count()) > 0;
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
    // also when it would warn about a duplicate thread.
    await page.waitForTimeout(3_000);
    await this.rejectIfDuplicateWarning(page);

    // Step: Essentiel — Dealabs usually auto-fills title/price from the
    // link already; we overwrite with our own values to make sure they
    // match the draft exactly. Each of these is `required: true`: if the
    // value doesn't actually stick, that's exactly the "looks finished
    // but a field is wrong/empty" failure mode — better to abort loudly
    // here than post something incomplete.
    await this.fillFirstMatch(
      page,
      [
        'input[name="title"]',
        'input[name="dealTitle"]',
        'input[placeholder*="itre" i]',
      ],
      draft.title,
      {
        clearFirst: true,
        byLabel: /titre/i,
        required: true,
        fieldName: "Titre",
      },
    );

    await this.fillFirstMatch(
      page,
      [
        'input[name="price"]',
        'input[name="temp_price"]',
        'input[placeholder*="prix" i]',
      ],
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
      draft.description ?? draft.body,
      {
        clearFirst: true,
        byLabel: /description/i,
        required: true,
        fieldName: "Description",
      },
    );
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
   * déjà été postée ?", with the existing thread linked via
   * `[data-t="threadDuplicatesItem"]` and a "Oui, annuler" button
   * (`[data-t="cancel"]`). We always treat this as a hard stop — Dealabs
   * itself is telling us this exact link was already submitted.
   */
  protected async rejectIfDuplicateWarning(
    page: import("playwright").Page,
  ): Promise<void> {
    const panel = page.locator('[data-t="threadDuplicates"]');
    if ((await panel.count()) === 0) {
      return;
    }

    const link = panel.locator('[data-t="threadDuplicatesItem"]').first();
    const existingUrl =
      (await link.count()) > 0 ? await link.getAttribute("href") : undefined;

    throw new DealabsDuplicateError(
      "Dealabs signale que ce deal existe déjà.",
      existingUrl ?? undefined,
    );
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
