# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

`AGENTS.md` (imported above) is the source of truth for directory layout and
general Alepha conventions; this file covers what is specific to this app.
`docs/architecture.md` (French) has the full design rationale, `DEPLOY.md` the
deployment detail.

## What this is

minpricing ("DealRadar"): a private, single-user app that collects prices
(Amazon, Cdiscount, AliExpress, Steam and other game stores, Lidl, IKEA,
telecom operators, a pasted product link), keeps price history, scores real
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

Pipeline: `CollectDealsJob` (hourly 8:00-23:00 + 2:00 and 5:00 Paris) → `CollectionService` →
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
  (15 searches per source and run, best scores first, cached 24h). Matching is strict on purpose: variant words
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
  itself — local server only, like auto-publish. On the Bay VM the browser
  runs on a virtual display (`DISPLAY=:99`) and the console shows it as an
  « écran distant » (`RemoteScreenService`, `/dealabs/screen`); if the
  session is missing or expired, auto-publish opens the login in that same
  window and continues once you've logged in. Local files (session, `config/`,
  `data/agents`) live under `appDir()` (Bay's `APP_FILES_DIR`). Auto-publish attempts are
  recorded on the draft (`publishAttempts`, `lastPublishResult`,
  `lastPublishError`); a "Vérifier" that doesn't confirm puts the draft back
  to `draft`. Draft texts never contain prices — except, for Amazon deals,
  Keepa's 90-day price chart (`services/keepa.ts`: the public
  `graph.keepa.com/pricehistory.png` image, no API key), which the
  publisher inserts at the top of the description through the editor's
  « Image » → « Image depuis une URL » dialog (Dealabs re-hosts it). Best-
  effort: a publish never fails over the chart. Also shown on the deal page
  (`KeepaChart.tsx`, click to enlarge, 30 d/90 d/6 m/1 y) — through
  `KeepaController` (`/api/keepa/:asin`, admin-only, cached 1 h), because
  Keepa answers 403 to an image request carrying another site's referrer.
  Deals from other shops matched to an Amazon page (`marketPriceUrl`) show
  that product's Amazon chart, labelled as such; only Amazon deals get it
  in the Dealabs description.
- **Auto-publish**: `AutoPublishService.publishDeal()` is the single publish
  path (button and run). At the end of `runAll()`, `publishBestDeals()` posts
  deals seen in that run with score ≥ `AUTO_PUBLISH_MIN_SCORE` (65), draft
  still `draft` and never attempted, best first, max
  `AUTO_PUBLISH_MAX_PER_RUN` (3), one per source per run, and at most
  `AUTO_PUBLISH_MAX_PER_DAY` (6) attempts over 24 h; skipped when
  serverless or no Dealabs session. **Off by default**
  (`AUTO_PUBLISH=true` turns it on); the per-deal button works either way.
  **Phases**: `publishDeal(dealId, trigger)` reports each step of the
  publication (list in `services/publishSteps.ts`: pre-flight checks,
  duplicate, merchant page, draft, chart, existing post, browser, Dealabs,
  Cloudflare, login, form steps, submit, session) to
  `PublishProgressService` (`$cache`, one current + one last run; never
  throws, so a progress write can't fail a publish). Cloudflare and login
  mark `needsHuman` (act in the « écran distant »). Served by
  `GET /dealabs/publish/progress` and the MCP tool `get_publish_progress`;
  drawn by `PublishSteps.tsx` on the deal page (polled while a run is
  active), in « Ce soir » and on the dashboard card. The finished run is
  saved on the draft (`lastPublishSteps`, JSON) so a night failure names
  its step. The console sends the long auto-publish POST alone before it
  starts polling: the client batches calls made within 10 ms, and a poll
  batched with it would wait for the whole publication.
  **Stopping**: `POST /dealabs/publish/stop` (admin session only) asks the
  run to stop; `PublishProgressService.begin()` (every phase boundary) and
  `touch()` (Cloudflare/login waits) are the stop points and throw
  `PublishCancelledError` — browser closed, run `cancelled`, the prevented
  step marked `stopped`, no attempt counted, a scheduled slot `cancelled`
  without trying the next deal or writing the ledger. Refused once
  « Envoi » (`POINT_OF_NO_RETURN`) has started. **Pause**
  (`PublishPauseService`, `.publish-pause.json` under `appDir()`, optional
  `until`): due slots are skipped with « publications en pause … » and
  `publishBestDeals` too; the deal-page button still publishes.
  `GET/PUT /dealabs/publish/pause` (PUT admin only), also in the progress
  and schedule responses. The console's `PublishBanner` (every page) shows a
  running publication with « Arrêter », a slot due within 10 min with
  « Reporter »/« Annuler », or the pause.
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
  customers are deliberately excluded. Sosh is read in the browser (its
  shop bounces through an Orange login cookie check). Plans rarely have a
  struck price, so `MarketReferenceService.refreshTelecom` (no browser)
  compares each mobile plan with the _other operators'_ stored plans
  giving at least as much data (`services/telecomMarket.ts`): the cheapest
  is its `marketPrice` — the "≥ 10 % under the competition" price argument
  that keeps a plan visible.
  `FreeGamesCollector` ("freegames"): GamerPower's public giveaway API cut
  down by `selectGiveaways` (full games from Steam/GOG/Ubisoft/EA/…, worth
  ≥ $10, mobile ≥ $5; no Epic — own source —, IndieGala, Stove, itch.io,
  VR, DLC or third-party "key giveaways"); each link is followed to the
  store page itself. Boulanger, Fnac and Darty block automated access —
  their official affiliate product feeds (Awin…) are the legitimate route. Dealabs titles are capped at 140
  characters by `dealabsTitle()`.
  `StoreCollectors.ts`: stores read with plain `fetch` from their own
  public APIs or server-rendered pages (parsers in
  `collectors/storeOffers.ts`) — Epic (free games of the week), GOG
  catalog API (trending), Nintendo eShop EU search index (popularity, top
  40), PlayStation Store GraphQL (persisted-query hash in the file; full
  games, 30-day best sellers), Xbox deals page (`__PRELOADED_STATE__`),
  Lidl search API (non-food aisles, `sort=percentageDiscount-desc`), IKEA
  limited-time offers, and (parsers in `collectors/retailOffers.ts`)
  E.Leclerc (universe pages' featured EANs → `products-details-by-skus`;
  Leclerc's own offer preferred over marketplace shops), Grosbill
  "prix barrés", Nike product-wall API, Foot Locker sale pages, Castorama
  "offre du moment" pages. `CarrefourCollector` reads Carrefour's non-food
  "bons plans high-tech & maison" page in the browser (403 to plain fetch;
  food promotions are loyalty-card/multi-buy mechanics, left out).
  Tested and left out: Fnac, Darty, Boulanger, Decathlon, Leroy Merlin,
  Intersport, Sephora, Marionnaud, Back Market, Rakuten, King Jouet,
  Humble, Intermarché, Auchan (bot-blocked or nothing rendered); LDLC
  promos (marketplace with fake struck prices); Apple refurbished (no
  reference price); Materiel.net (no struck prices); Dell, Lookfantastic
  (promo codes, not prices).
- **Quality gate & visibility**: `services/qualityGate.ts` rejects offers at
  collection time (product < 4/5 on ≥ 20 reviews — 4.5 on AliExpress —,
  marketplace seller < 4/5 or < 50 sales, low-end Celeron/N4000 laptops,
  no-name AliExpress products, games with < 1000 Steam / < 300 GOG
  reviews, a saving under 5 € except free items and monthly plans); existing
  deals that fail are archived. Collectors call
  `DiscoverContext.worthFetching(title)` to skip title-disqualified offers
  before opening product pages; Amazon also skips cards whose badge
  announces < 20 %. Deals under `MIN_VISIBLE_SCORE` (40) are hidden from
  lists and get no draft. **No price argument, no deal**: `evaluate()` caps
  the score at 39 unless the deal has a real drop ≥ 20 % vs a trusted
  reference (≥ 40 % vs a "prix conseillé" with good reviews), is ≥ 10 %
  under the best alternative, or matches the lowest price ever seen (with
  a real drop) — seller and reviews alone reach ~50 points otherwise.
  Colour variants (same source, first 6 title words, price to the euro —
  `services/sameListing.ts`) are shown once and never auto-published twice.
  Deals no successful run has listed for 48 h are marked `expired`
  (`CollectionService.expireUnseen`); seen again, they come back active.
- **Freshness** (`services/freshness.ts`): a deal is "new" when first seen
  or when its price really drops (≥ 1 % and ≥ 0,50 €) — `freshAt`,
  `freshReason` (`new` | `price-drop`), `droppedFrom`. Seen again unchanged,
  it keeps its date; a new row that is the same listing as an existing deal
  (`sameListingSibling`) inherits that deal's date. The "Plus récents"
  sort, the dashboard's newest rail, the card's badge (« Nouveau » /
  « Prix en baisse · était X € ») and its time all use `freshAt`. Deals from
  before `freshAt` get their first-seen date at startup
  (`SeedService.backfillDealMetadata`, one `updateMany` with
  `sql\`"first_seen_at"\``): the dev server can add a new column itself,
so a migration's own `UPDATE` may never run. Run summaries count new
deals and, separately, the visible ones (`createdVisible`).
- **Greyed cards**: lists and the dashboard add `onDealabs` to each deal
  (`DealsController.withDealabsStatus`): « Publié par vous » for a
  published draft or one of our live posts read from our profile
  (`MyDealabsPostsService`, cached 1 h, refreshed in the background —
  matched with `isSameProduct`, so a different Dealabs title still
  matches); « Déjà sur Dealabs · N° · price » for anyone's live deal for
  the product posted within 30 days, at any price (`liveOnDealabs`, from
  the stored history). The history of the 20 top-potential visible deals is
  re-checked every 6 h at the end of each run (`refreshTop`), others every
  24 h. In `isSameProduct`, a thread listing several platforms ("sur PS5
  et Xbox Series X") matches if one of them is ours.
- **Computers** (`services/pcSpecs.ts`): a title is a computer when it
  says so _and_ carries a spec (CPU/RAM/SSD) — a laptop bag doesn't. The
  quality gate rejects computers without a known maker (`KNOWN_PC_BRANDS`:
  makers and unmistakable series only, plus the mini-PC brands Beelink,
  Minisforum, Geekom, GMKtec); the score warns on weak configs for the
  price (8 Go RAM at 600 €+, 256 Go SSD at 700 €+, 4 Go RAM). Sources:
  Lenovo's store API (`LenovoCollector`, on-sale facet `4104`; pre-configured
  "NB …" models encode their specs in the name, see `lenovoNameSpecs`),
  Joybuy's /offer lightning deals (`JoybuyCollector`, parsing in
  `collectors/joybuyOffers.ts`: Next.js `self.__next_f` payload,
  `initLightningDataList`; product pages answer bots with a captcha, so
  only the listing is read). Joybuy labels its struck price « Prix
  conseillé » (`rrp`): its deals become visible through the model
  cross-search on Amazon/Cdiscount (`MarketReferenceService.refreshByModel`,
  shared with AliExpress) when ≥ 10 % cheaper.
  ITJustGood's "Opération spéciale" page (`ItJustGoodCollector`, refurbished
  business laptops; its struck "Neuf équivalent" is a new machine's price,
  so `listPriceKind: "rrp"` and `condition: "refurbished"` — with no
  reviews on the site, these stay under the visibility bar unless another
  price argument appears),
  Cdiscount's informatique pages (30-day low shown), Amazon's computing
  collection, Grosbill, Leclerc high-tech. Tested and left out: HP (basket
  codes, not prices), Dell (mostly -10 % business models), Asus/Acer/MSI
  stores, Frandroid's comparator (client-side prices).
- **Store price histories** (`services/priceSeries.ts`,
  `PriceSeriesService`): for deals Keepa can't chart. Nintendo eShop:
  DekuDeals' item page embeds every day's French eShop price
  (`price_history_data`); the game is found by DekuDeals' search (exact
  name only, no DLC/bundle). After a Nintendo run, `refreshLows` stores the
  two-year low as `historicalLow*` (20 lookups/run, paced, cached 24 h).
  The deal page shows it (`StoreHistoryChart`, via
  `/deals/:id/external-history`), and the publisher inserts a QuickChart
  PNG of the last year (weekly samples, so the label axis stays
  proportional to time) at the top of the Dealabs description. Tested and
  unavailable: Idealo history (browser refused), LeDénicheur, PSPrices,
  gg.deals (403); IsThereAnyDeal needs `ITAD_API_KEY` (free).
- **Silent drops** (`AmazonWatchCollector`, source `amazon-watch`): Amazon
  price drops shown as no promotion. Each run reads the best-seller lists
  of a few of 14 categories (`AMAZON_WATCH_CATEGORIES_PER_RUN`, 4, taking
  turns hour by hour — `categoriesForRun`; plain fetch, 2 pages each, 3–6 s
  apart, **stopping at Amazon's first robot check**, never retrying around
  it; parser `readBestSellerPage` in `services/amazonWatch.ts`), skips
  items under `AMAZON_WATCH_MIN_PRICE` (20 €) and « N offres à partir de »
  cards (marketplace only), and re-reads `AMAZON_WATCH_KNOWN_PER_RUN` (8)
  known products on their own page (Amazon/relaunch/silent-drop deals that
  expired or were archived in the last 60 days, `knownToRead`). It
  records every price in `PriceHistory` under `watch:<ASIN>`
  (`AmazonWatchService`, on change + daily heartbeat), and flags a drop
  (`assessSilentDrop`, which also says why not): watched ≥ 3 days, ≥ 15 %
  and ≥ 5 € under the usual price (median of the last 30 daily prices),
  at or under the month's low, not more than two-thirds off (a placeholder
  price, not a deal), and **steady before** (≥ 70 % of the last 3 days'
  observations within ±5 % of the usual price — a buy box changing hands
  all day is noise). Each run notes one line (`formatWatchStats`, through
  `DiscoverContext.note` → run log + progress sidebar): pages read / robot
  checks / empty, cards, items without an Amazon price, too cheap, known
  products read, prices watched, rejections by reason, drops, already
  promoted, unconfirmed, deals. Checking prices from the cloud sandbox:
  Amazon serves it prices **without VAT** (÷ 1.2) — never compare them
  with production's history. Products Amazon already shows as a promotion (active `amazon`
  deal) are skipped; up to 12 product pages per run confirm the drop. The
  deal's `listPrice` is our measured usual price (`regular`). Tested and
  unavailable: camelcamelcamel (security check), Keepa deals (paid API),
  Movers & Shakers (nothing rendered to a plain request).
- **Relaunches** (`RelaunchCollector`, source `relances`): products that
  already went hot. `HotWatchlistService` reads Dealabs' public "hot" pages
  once a day (15 pages, paced) and keeps Amazon deals at 300°+ for 120
  days. Each run, 12 of those whose deal is over (expired, or 3 weeks old)
  are searched on Amazon by title (`searchAmazon` + `titlesMatch`) — never
  through Dealabs' click-out redirects, which would count as visits — and
  become a deal only when back within 2 % of the price that made them hot.
- **Heat prediction** (`services/heatPrediction.ts`): next to the score
  (is the price good?), `hotChance` estimates the chance (0-100) that a deal
  reaches 100° on Dealabs, with French reasons (`hotReasons`), computed in
  `rescore()` and served live in `/deals/:id/price-stats` → `heat`. Base
  log-odds fitted on ~2 000 matured Dealabs deals (category, real discount,
  price band — weak alone, AUC 0.63) plus product terms learned from our own
  posts: past Dealabs heat of the product, price vs the lowest already
  posted, a still-live repost within 14 days, marketplace seller, unknown
  product; an account offset calibrates it to our posts (~10 % reach 100°).
  Indicative only (AUC ~0.65 on our posts). Used by the "Potentiel Dealabs"
  sort and by auto-publish (`AUTO_PUBLISH_MIN_HOT_CHANCE`, 35).
  **Desirability** (`services/desirability.ts`): brand and product-type
  terms from `config/desirability.json` (re-read when it changes; none on
  Workers), added through `predictDealHeat` — no brand term for video games
  (their titles name the store), an unknown-brand penalty for tech/home/DIY.
  Weights are measured on the Dealabs threads stored in deals' history and
  tuned daily by the local `deals-debrief` skill (`docs/desirability-changelog.md`).
- **Collection tuning** (`services/collectionTuning.ts`): before each run,
  `CollectionService.applyCollectionTuning()` adds the enabled
  `extraPages` of `config/collection.json` to the Amazon/Cdiscount defaults
  and applies its clamped `limit` (`setTargets` on the collectors) — no
  restart needed. Agents only toggle listed, verified pages. Its `sources`
  map schedules each source (`sourceDue`: `enabled: false` skips it in
  `runAll()` and lets its deals expire; `everyHours` 1–24 since its last
  success), never for `lockedSources`. Each run appends time and yield per
  source to `data/agents/collection-runs.jsonl` (local only). The daily
  `deals-sources` skill owns this file (see `docs/sources-changelog.md`).
- **Local agents** (`.claude/agents`, `.claude/skills/deals-*`,
  `scripts/agents/`): a Windows scheduled task runs `evening.ps1` at 17:00
  — selection (Mon–Fri), random-time publishing through
  `/api/admin/agent-report` and the publish endpoint, Notion logs, weekly
  review of `config/publish-rules.json` (Sunday), a daily sources review
  (`deals-sources`: yield per source vs what goes hot on Dealabs →
  `config/collection.json`, `probe` of new shops, source proposals for
  `deals-code`), and an evening debrief (`deals-debrief`: our Dealabs profile and its comments → `config/selection-lessons.md`, desirability, collection, small rule steps, Notion analysis). Everything
  deterministic is in `scripts/agents/dealradar.mjs`; Claude only judges. The cloud
  routines' health (`services/agentHealth.ts`: each slot must leave its
  dated file — queue, sources/debrief/bilan report — within 90 min, plus
  what it changed) is served by `GET /agents/health`, the MCP tool
  `get_agent_health` and the « Routines planifiées » card of the Agents page. The Dealabs
  history stores our own threads tagged `mine` (`DEALABS_USERNAME`) but never
  counts them in the score's figures or the prediction, and, in
  `isSameProduct`, bundles/roundups, a short name without its model code,
  and kids vs adult sizes.
- **Agent API** (`AgentApiController`, `AgentFilesService`,
  `services/agentConfig.ts`): `AGENT_TOKEN` (Bearer, ≥ 32 chars) opens
  the console's GETs (`$adminSession` lets it through on GET only) and
  `/agent/*` — never an admin write. `PUT /agent/config/:name`
  (publish-rules, desirability, collection, selection-lessons) is checked
  against the file's own bounds (locked: `bounds`, `adamPreferences`,
  `publishDays`, `window`, `lockedSources`, page URLs…; 422 otherwise),
  keeps `<name>.previous.*`, inserts the changelog entry in
  `docs/*-changelog.md` and writes an `agent_writes` audit row
  (`GET /agent/changes`, MCP `get_agent_changes`). Reports, code
  proposals and whitelisted daily files (`data/agents/<kind>-<date>.json`)
  go through `/agent/reports|proposals|data`. All files live under
  `appDir()` (Bay's persistent `APP_FILES_DIR`). `dealradar.mjs` in remote
  mode (`DEALRADAR_URL` + `DEALRADAR_TOKEN`) pulls configs and today's
  files before a command and pushes back what it wrote (data files and
  the last 2 days' reports by sha1, `.data-base.json`); `push-config` /
  `push-proposal` send edits; `publish` is refused. Without a local DB it
  queries `GET /agent/dataset` (in-memory SQLite), and `profile-review`
  has the VM read Dealabs comments in its browser
  (`POST /agent/dealabs-comments`, Dealabs thread URLs only, 6 max).
- **Publishing schedule** (`PublishScheduleService`, `PublishScheduleJob`
  every 5 min, entity `publish_schedule`): `PUT /agent/schedule` (what
  `publish-queue` sends in remote mode) hands the ranked deals over; the
  app draws 2–5 times in the rules' window `minGapMinutes` apart (Paris
  time, `services/publishPlan.ts`) or takes explicit `times`, `now`
  or `dryRun` (page check only). Each due entry tries up to 4 deals of the
  ranking through `AutoPublishService.publishDeal` — never one already
  tried today, category caps, `perDay.max` and `AUTO_PUBLISH_MAX_PER_DAY`
  — and appends to `data/agents/ledger.jsonl` (script format) and
  `published-<date>.json`. Entries > 3 h late are skipped; no Dealabs
  session = skipped. Shown, cancelled and moved in the Agents page
  (« Ce soir »), MCP `get_publish_schedule`. The jobs queue runs 2 workers
  (`main.server.ts`) so a long collection doesn't hold a publishing time.
- **Speed**: `runAll()` runs sources in parallel (`COLLECT_SOURCE_CONCURRENCY`,
  default 3, heavy ones first); Amazon/Cdiscount/AliExpress open product
  pages 3 at a time and listing pages 2 at a time (`mapWithConcurrency` in
  `browser.ts`, each page in its
  own context). Dealabs history requests are paced app-wide (1 per 1.5 s).
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
- **MCP (read-only, for Claude)**: `POST /mcp` (Alepha `StreamableHttpMcpTransport`)
  serves the tools of `controllers/McpTools.ts` — deals, detail, history,
  sources, collection progress, stats, agent shortlist/reports, config files
  (by name only), our Dealabs posts, session status. Every tool is
  `readOnlyHint`; none writes, publishes or starts a run. Most call the
  console's GET actions, which `$adminSession()` lets through when the
  `/mcp` request carried a valid token (`request.metadata.mcpAgent`).
  Auth is a stateless single-admin OAuth 2.1 server
  (`McpOAuthController` + `McpOAuthService`: HMAC-signed tokens from
  `APP_SECRET`, dynamic client registration, PKCE S256, codes 5 min and
  single use, access 1 h, refresh 30 d; no table). Connect in claude.ai →
  Settings → Connectors → custom connector `https://<host>/mcp`, then log in
  with the admin credentials on the DealRadar page. `test/mcp.spec.ts`.
- **Add by link** (epic 16): a product page link pasted in the console
  (« Ajouter un lien », dashboard and deals page) or sent by an agent
  (`POST /agent/links`, audited, 20/24 h; `dealradar.mjs add-link <url>
[agent] [reason] [--wait]`). `services/linkResolver.ts` (pure, tested)
  follows short links (amzn.to, s.click.aliexpress… 5 hops, never a
  Dealabs link), drops tracking params and matches `SUPPORTED_SHOPS`
  (Amazon.fr, Cdiscount, AliExpress, Steam) → the same
  `(sourceId, externalId)` key collection uses (ASIN, Cdiscount page URL,
  item id, appid), so a linked product also collected is **one deal**;
  anything else is refused at once, in French. The link is stored in
  `watched_links` (`WatchedLinkService`) and read by its shop's own
  collector through `collect(products)` (`ProductRef`; Amazon
  `fetchPrice`, Cdiscount `fetchDetails` incl. the page's own price,
  AliExpress `fetchDetails`, Steam appdetails — `readProductPages` in
  `browser.ts`): right away by `LinkCheckJob` → `CollectionService.
checkLink` (one at a time per shop, steps in `linkSteps.ts` stored on
  the link and polled by the console), then on every run of that shop.
  No bypass: `upsertDeal` (quality gate), market comparison and Dealabs
  history focused on that deal (`focus` on `refreshStale`), `rescore`.
  `linkVerdict.ts` says the outcome in French (visible with score / gate
  reason / « pas d'argument prix » / under 40 / already live on Dealabs /
  page unreadable). A blocked product page (AliExpress answers servers
  with its bot check) falls back to the offer collection read on the
  shop's own listings in the last 48 h (`listedDeal`, same key, verdict
  says so); never through the shop's internal APIs. Refused links stay watched; the watch ends after 14
  days or when the deal expires. Deals carry `addedByLink`; Admin ›
  « Liens ajoutés » lists them (Revérifier, Arrêter). Manual price entry
  (`ManualCollector`, `PATCH /products/:id/price`, the `manual` and
  `manual-link` sources) is gone: at startup `SeedService` turns tracked
  products in a supported shop into watched links and lists the others
  for removal. To support a new shop: a `SUPPORTED_SHOPS` entry and a
  `collect()` on its collector, with a fixture test
  (`test/link-collect.spec.ts`).
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
  weights and `Source.type` (`"api" | "manual" | "scrape"`). No source is
  `manual` any more (manual price entry was retired for links); a linked
  product is scored with its shop's own type.

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
