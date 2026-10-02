# minpricing (DealRadar)

A private, single-user Alepha app: collect prices for a small catalogue of
products (Amazon, Cdiscount, Steam), keep price history, score real
discounts, generate a Dealabs post draft, and — once you've logged in once
via `npm run dealabs:login` — auto-publish it to Dealabs with Playwright
using your own saved session. There is no public site, no SEO.

Follow `AGENTS.md` for the project layout (`src/api`, `src/web`,
`src/main.*`) and general Alepha conventions — it is the source of truth
for directory structure and is not repeated here. `docs/architecture.md`
(French) has the full design rationale if you need the "why" behind a
decision below.

## Commands

```bash
npm run dev          # alepha dev — also creates .env from .env.example on first run
npm run lint          # alepha lint
npm run typecheck     # alepha typecheck
npm run test          # alepha test (Vitest under the hood)
npm run build         # alepha build
npm run verify        # alepha verify — clean, lint, typecheck, test, migration check, build; the one command worth running before considering a change done
```

Run a single spec with `npm run test -- test/dummy.spec.ts`, or a single
case with `npm run test -- -t "test name"` (standard Vitest CLI, since
`alepha test` wraps Vitest — config lives in `vite.config.ts`, not a
separate `vitest.config.ts`).

Never run `alepha db migrations create` in this project (see below) —
use `alepha db migrations check` to validate schema drift instead.

## Architecture

Pipeline: `Cron ($job) → Collectors → raw offers → normalize/dedupe →
PriceHistory (insert only on price change) → Scoring → D1 entities →
$action API → React console (+ Dealabs draft)`.

- **Collectors** (`src/api/collectors/`) implement `DealSource`
  (`collect(products)` and/or `discover()`), one per source
  (`AmazonCollector`, `CdiscountCollector`, `SteamCollector`,
  `ManualCollector`). A collector must never throw for a single failing
  product — skip it and let the caller log the failure so one bad product
  never blocks the rest of the run.
  - `browser.ts` provides a shared `withBrowser`/`withPage` abstraction
    used by the Amazon/Cdiscount collectors that transparently switches
    engine: local headless Chromium via `playwright` (dev / bare Node
    deploy) vs. `@cloudflare/puppeteer` + the `BROWSER` binding (Cloudflare
    Workers). If the Browser Rendering binding's shape ever changes, this
    is the only file to touch.
  - `playwright` must stay a dynamic `await import("playwright")` inside
    the non-Cloudflare branch — Workers validates every static top-level
    import at deploy time and rejects the bundle otherwise, even on a path
    that never executes there. `@cloudflare/puppeteer` must NOT be added
    to Vite's `ssr.external` (it genuinely needs to run inside workerd);
    `playwright`/`playwright-core` already are, in `vite.config.ts`.
- **Services** (`src/api/services/`): `CollectionService` orchestrates
  collectors, `PricingService` and `ScoringService` turn raw offers +
  history into a `score`, `DealabsDraftService` generates the Dealabs post
  draft once a deal crosses the score threshold (synchronous, same job
  run — no `$topic` decoupling at this volume), `DealabsPublisherService`
  drives a Playwright browser authenticated with your saved Dealabs
  session (`npm run dealabs:login`) to fill and submit the real form,
  `SeedService` seeds data.
- **Entities** (`src/api/entities/`): `Deal`, `PriceHistory`, `Source`,
  `Merchant`, `Category`, `TrackedProduct`, `DealabsDraft`. Dedup key is
  `(sourceId, externalId)` (enforced as a unique index on `deals`), with
  canonical URL as fallback — no fuzzy matching.
- **Controllers** (`src/api/controllers/`): one `$action`-based controller
  per resource (`DealsController`, `CatalogController`, `SourcesController`,
  `ProductsController`, `DraftsController`, `AdminController`), registered
  in `src/api/index.ts`'s `ApiModule`.
- **Jobs** (`src/api/jobs/`): `CollectDealsJob` is the only `$job`, a cron
  that iterates active `Source`s and runs each collector in isolation (one
  source failing doesn't block the others). No Queue at this volume — if a
  specific collector later needs one, migrate only that collector to a
  queue job pushed by the cron, without touching the others.
- **Web** (`src/web/`): `AppRouter.ts` declares `$page` routes and
  `$client<Controller>()` typed API clients (one per controller, mirroring
  the backend's controller list) consumed by page loaders; components are
  lazy-loaded (`lazy: () => import(...)`).

## Conventions

- Dedup/uniqueness and scoring logic are intentionally simple and
  explainable (plain weighted formula in `ScoringService`, no ML) — keep
  changes to it transparent and documented inline rather than opaque.
- Source reliability ordering: API > manual entry > scrape — reflected in
  scoring weights and in `Source.type` (`"api" | "manual" | "scrape"`).
- `PriceHistory` only gets a new row when the price actually changes (plus
  an occasional heartbeat) — don't write a history row on every collection
  run unconditionally.
- Auto-publish (`DealabsPublisherService`) only ever acts with a session
  _you_ created yourself via `npm run dealabs:login` (Playwright
  `storageState`, gitignored, local-only) — it never sees or stores your
  Dealabs password, and it refuses to run on the serverless deployment
  (no persisted browser session there). `DealabsDraft.status` is still
  settable manually for the copy/paste flow, but auto-publish is now what
  sets it to `"posted"` on the happy path.

## Deployment gotchas (see `DEPLOY.md` for full detail)

- Deploys via Cloudflare Workers using Alepha's `platform` plugin
  (`alepha.config.ts`), which auto-provisions D1/R2/KV/Queues/cron from
  `$repository`/`$storage`/`$cache`/`$job` declarations.
- After the first `alepha platform up`, **don't run `up` again** — it
  regenerates `dist/wrangler.jsonc` and drops the `browser` binding the
  Amazon/Cdiscount collectors need. Use `npm run deploy:cloudflare`
  instead, which builds, runs `scripts/patch-cloudflare-browser-binding.mjs`
  to re-patch that binding, migrates, then deploys.
- Do not run `alepha db migrations create` in this repo: it only sees
  repositories that have been instantiated at boot and silently generates a
  migration that drops real tables (`deals`, `sources`, etc.). The existing
  migration under `migrations/sqlite/` was generated by driving Alepha's
  internal migration provider directly; if a new migration is needed, do
  the same and sanity-check the generated SQL (an unexpected `DROP TABLE`
  is the tell) or verify with `alepha db migrations check`.
