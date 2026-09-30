#!/usr/bin/env node
/**
 * Injects the Cloudflare Workers "Browser Rendering" binding into
 * `dist/wrangler.jsonc`, which `alepha platform build` regenerates from
 * scratch on every build and knows nothing about (it only understands D1,
 * R2, KV, Queues and cron triggers).
 *
 * Run this AFTER `alepha platform build --env <env>` and BEFORE
 * `alepha platform deploy --env <env>` — `deploy` only merges `.vars` into
 * the existing file, so a binding added here survives it untouched.
 *
 * See DEPLOY.md for the full deploy sequence and why this step exists
 * (Amazon/Cdiscount's collectors need a real headless browser, which
 * Playwright can't run inside Workers — this binding is Cloudflare's own
 * remote-browser alternative, see AmazonCollector.ts / browser.ts).
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const configPath = join(process.cwd(), "dist", "wrangler.jsonc");

const raw = await readFile(configPath, "utf8");
const config = JSON.parse(raw);

config.browser = { binding: "BROWSER" };

await writeFile(configPath, JSON.stringify(config, null, 2));

console.log(`Patched ${configPath}: added "browser" binding (BROWSER).`);
