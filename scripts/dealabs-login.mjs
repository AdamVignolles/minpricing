#!/usr/bin/env node
import { dirname, join } from "node:path";
/**
 * One-time (well, until Dealabs expires the session) interactive login.
 *
 * Opens a real, visible Chromium window on https://www.dealabs.com so you
 * can log in by hand — including any 2FA/captcha challenge — exactly like
 * a normal visitor. Once you confirm you're logged in (press Enter in this
 * terminal), the browser's cookies/local storage are saved to
 * `.dealabs-session.json` at the repo root.
 *
 * `DealabsPublisherService` reuses that file to drive a headless browser
 * that is already authenticated, so the automated publish flow never
 * touches your password and never needs it to ask you to type it
 * somewhere a script can read it.
 *
 * Run with: `npm run dealabs:login`
 *
 * Re-run whenever auto-publish starts failing with a "not logged in"
 * error — Dealabs sessions expire periodically like any site's would.
 */
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const sessionPath = join(root, ".dealabs-session.json");

const browser = await chromium.launch({ headless: false });
const context = await browser.newContext({ locale: "fr-FR" });
const page = await context.newPage();
await page.goto("https://www.dealabs.com/");

console.log("\nA browser window just opened on dealabs.com.");
console.log(
  "Log in there by hand (email/password, 2FA, captcha — whatever Dealabs asks for).",
);
const rl = createInterface({ input: process.stdin, output: process.stdout });
await rl.question(
  "Once you're logged in, press Enter here to save the session… ",
);
rl.close();

await context.storageState({ path: sessionPath });
await browser.close();

console.log(`Session saved to ${sessionPath}.`);
console.log(
  'You can now use the "Publication automatique" button in the console.',
);
