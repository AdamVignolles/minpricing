# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

`AGENTS.md` (imported above) is the source of truth for directory layout and
general Alepha conventions; this file covers what is specific to this app.
`docs/architecture.md` (French) has the full design rationale, `DEPLOY.md` the
deployment detail.

## What this is

minpricing ("DealRadar"): a private, single-user app that collects prices
(Amazon, Cdiscount, Steam, manual entry), keeps price history, scores real
discounts, generates a Dealabs post draft, and can auto-publish it to Dealabs
via Playwright using a session saved locally by `npm run dealabs:login`. No
public pages, no SEO — every route sits behind the admin session.

## Commands

```bash
npm run dev          # alepha dev (creates .env from .env.example on first run)
npm run lint         # alepha lint
npm run typecheck    # alepha typecheck
npm run test         # alepha test (Vitest; config is the `test` key in vite.config.ts)
npm run verify       # clean + lint + typecheck + test + migration check + build — run before calling a change done
npm run test -- test/admin-auth.spec.ts   # single spec
npm run test -- -t "test name"            # single case
npm run deploy:cloudflare                 # build → patch browser binding → D1 migrate → deploy
```

## Architecture

Pipeline: `CollectDealsJob` (cron every 30 min) → `CollectionService` →
collectors → normalize/dedupe → `PriceHistory` → scoring → entities → `$action`
controllers → React console → Dealabs draft / auto-publish.

- **Collectors** (`src/api/collectors/`) implement `DealSource`
  (`collect(products)` and/or `discover()`). A collector must never throw for
  one failing product — skip it so the rest of the run proceeds. Each source
  also runs in isolation inside the job.
- **`collectors/browser.ts`** (`withBrowser`/`withPage`) switches engine:
  local `playwright` Chromium on Node vs. `@cloudflare/puppeteer` + the
  `BROWSER` binding on Workers. `playwright` must stay a dynamic
  `await import("playwright")` inside the non-Cloudflare branch (Workers
  rejects the bundle on any static import of it); keep `playwright` in
  `ssr.external` and never add `@cloudflare/puppeteer` there.
- **Scoring**: `ScoringService.evaluate()` returns a score /100 as six named,
  capped criteria (real price drop 30, competitive price 15, seller 20,
  product reviews 15, price history 10, data confidence 10), each with a French explanation,
  plus warnings. The same call feeds the stored `score` and the detail page's
  breakdown (`/deals/:id/price-stats` → `analysis`), so they can't diverge.
  Missing signals score neutral, never zero. "Normal price" references are
  ranked by trust: Amazon's "prix le plus bas des 30 derniers jours" and
  Steam's regular price over our history over a "prix conseillé" (half
  weight). Keep changes transparent and covered in `test/scoring.spec.ts`.
- **Deal details**: collectors attach `RawDeal.details` (seller, rating,
  offers, reviews, EAN, 30-day low). Cdiscount opens each product page and its
  offers layer (pure parsers in `collectors/cdiscountOffers.ts`), only when
  `DiscoverContext.needsDetails()` says the stored details are >24h old.
  `MarketReferenceService` looks up a deal's EAN on Amazon (max 15/run, cached
  24h, title-matched) as a cross-merchant price. Idealo and leDénicheur block
  headless browsers, so they aren't used for this.
  `IdealoReferenceService` enriches scoring with Idealo's lowest market price
  for tracked products that have an `idealoUrl` (cached 24h); it is
  deliberately _not_ a `DealSource`.
- **Price history references** (run after each source's upserts, then the
  touched deals are rescored): `DealabsHistoryService` reads Dealabs' public
  search page with plain `fetch` (threads are JSON in `data-vue3` attributes,
  parsers in `services/dealabsSearch.ts`) and stores the matching past deals
  (25 searches/run, cached 24h). Matching is strict on purpose: variant words
  (Plus/Max/Pro…) must agree both ways, foreign-store deals are dropped.
  `ItadService` (Steam only, no-op unless `ITAD_API_KEY` is set) stores the
  IsThereAnyDeal all-time low and serves the Steam price curve on demand.
- **Collection progress**: `CollectionProgressService` keeps the live state
  of a run (per source: status, step, done/total; recent events) in a
  `$cache` (memory locally, KV on Cloudflare) so the console's right-hand
  sidebar (`CollectionProgressAside`) can poll `/admin/collect/progress`.
  Collectors report steps through `DiscoverContext.progress()`.
  `runAll()` skips if a run is already in progress; `POST /admin/collect`
  only triggers the job and returns immediately.
- **Dealabs login**: `DealabsSessionService` opens a visible Playwright
  window on the Dealabs login (button « Se connecter à Dealabs » on the deal
  page), detects the logged-in state and saves `.dealabs-session.json`
  itself — local server only, like auto-publish. Auto-publish attempts are
  recorded on the draft (`publishAttempts`, `lastPublishResult`,
  `lastPublishError`); a "Vérifier" that doesn't confirm puts the draft back
  to `draft`. Draft texts never contain prices.
- **Auto-publish**: `AutoPublishService.publishDeal()` is the single publish
  path (button and run). At the end of `runAll()`, `publishBestDeals()` posts
  deals seen in that run with score ≥ `AUTO_PUBLISH_MIN_SCORE` (65), draft
  still `draft` and never attempted, best first, max
  `AUTO_PUBLISH_MAX_PER_RUN` (3); skipped when serverless or no Dealabs
  session. `AUTO_PUBLISH=false` turns it off.
- **Other sources**: `AliExpressCollector` ("Deal du Jour" listing plus
  phone/PC/tablet searches with `shipFromCountry=FR`; product page only for
  new/stale deals; parsing in `collectors/aliexpressSignals.ts`). Branded
  AliExpress products are cross-searched by model on Amazon and Cdiscount
  (`MarketReferenceService.refreshAliExpress`, matching rules in
  `services/crossSearch.ts`: model words, variant right after the model,
  storage, no accessories); matches go to `Deal.marketComparisons` (the
  deal page's comparison table), the cheapest to `marketPrice`.
  `TelecomCollectors.ts` (Orange, Free, Bouygues/B&YOU, RED by SFR): mobile
  plans and boxes via plain `fetch` of each operator's page or public API
  (parsers in `collectors/telecomOffers.ts`); `billingPeriod: "month"`,
  category `telecom`. Phones sold with a plan and offers reserved to box
  customers are deliberately excluded. Dealabs titles are capped at 140
  characters by `dealabsTitle()`.
- **Categories**: collectors set `RawDeal.categoryHint` from the merchant's
  own classification (Amazon `deals?bubble-id=deals-collection-<x>`, the
  Amazon breadcrumb, the Cdiscount URL path); `CategorizationService.fromHint`
  maps it, title keywords are only the fallback. Listing pages are taken
  round-robin (`interleave` in `browser.ts`) so every category gets its share
  of `*_DEALS_LIMIT`.
- **Dealabs**: `DealabsDraftService` creates a draft synchronously when a deal
  crosses the score threshold. `DealabsPublisherService` fills the real form
  using the locally saved Playwright `storageState` (gitignored); it never
  handles the Dealabs password and refuses to run on the serverless deployment.
- **Jobs run in queue mode**: `main.server.ts` uses `AlephaApiJobsQueue` so
  that on Cloudflare the job runs on a Queue consumer (15 min budget) instead of
  the ~30s `waitUntil` budget.
- **Auth**: single admin, no user table. `AuthController` login checks
  `ADMIN_USERNAME`/`ADMIN_PASSWORD` and sets a signed httpOnly cookie
  (`src/api/services/AdminAuth.ts`); every other controller guards its actions
  with `$adminSession()`. (`.env.example` still describes this as HTTP Basic
  Auth — that is outdated.) `test/admin-auth.spec.ts` covers the gate.
- **Web**: `src/web/AppRouter.ts` declares `$page` routes and one
  `$client<Controller>()` per backend controller; pages are lazy-loaded.
  New controllers must be registered in `src/api/index.ts` and get a matching
  client in `AppRouter.ts`.

## Data rules

- Dedup key is `(sourceId, externalId)` (unique index on `deals`), with
  canonical URL as fallback — no fuzzy matching.
- `PriceHistory` gets a row only when the price changes (plus an occasional
  heartbeat), never unconditionally on each run.
- Source reliability order API > manual > scrape is reflected in scoring
  weights and `Source.type` (`"api" | "manual" | "scrape"`).

## Migrations and deployment gotchas

- **Never run `alepha db migrations create`.** It only sees repositories
  instantiated at boot and silently generates a migration that drops real
  tables. New migrations under `migrations/sqlite/` are written by hand (or by
  driving Alepha's migration provider directly); check the SQL for an
  unexpected `DROP TABLE` and validate with `alepha db migrations check`.
- **After the first deploy, never run `alepha platform up` again**: it
  regenerates `dist/wrangler.jsonc` and drops the Browser Rendering binding the
  Amazon/Cdiscount collectors need. Use `npm run deploy:cloudflare`, which runs
  `scripts/patch-cloudflare-browser-binding.mjs` to restore it.
