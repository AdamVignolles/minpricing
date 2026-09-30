# Deploying to Cloudflare

This app deploys as a single Cloudflare Worker via Alepha's built-in
`platform` plugin (already enabled in `alepha.config.ts`). D1, R2, KV,
Queues and cron triggers are auto-provisioned from the app's
`$repository`/`$storage`/`$cache`/`$job` declarations — there is no
`wrangler.toml`/`wrangler.jsonc` to maintain by hand, **except** for one
binding Alepha doesn't know about yet (see below).

## One-time setup

```bash
wrangler login   # opens a browser, authorizes this machine against your Cloudflare account
```

`wrangler login` stores a token under `~/.wrangler`; every command below
reuses it. On a machine where an interactive login isn't possible (CI),
set `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` instead.

Also make sure **Browser Rendering** is enabled on your Cloudflare account
(Cloudflare dashboard → Compute → Workers → Browser Rendering) — it's what
lets the Amazon/Cdiscount collectors run a real headless browser once the
app is on Workers (Playwright can't spawn a local Chromium process there;
see `src/api/collectors/browser.ts`).

## First deploy

```bash
npx alepha platform plan --env production   # preview what will be created
npx alepha platform up --env production     # provisions D1/R2/KV + builds + migrates + deploys
```

This first `up` deploys successfully, but Amazon/Cdiscount will silently
find 0 deals until the extra step below is applied once (the binding
doesn't exist yet — Steam still works, it's a plain API call).

## Every deploy after that

`alepha platform up` regenerates `dist/wrangler.jsonc` from scratch and
doesn't know how to declare a `browser` binding (Alepha's Cloudflare
adapter currently supports D1/R2/KV/Queues/cron only), so **don't use
`up` again** — run the build/deploy steps separately instead, so a small
script can patch the binding into the generated config in between:

```bash
npm run deploy:cloudflare
```

This runs, in order:

1. `alepha platform build --env production` — bundles the Worker and
   (re)writes `dist/wrangler.jsonc` from the app's resource declarations.
2. `node scripts/patch-cloudflare-browser-binding.mjs` — adds
   `"browser": { "binding": "BROWSER" }` to that file. `alepha platform
deploy` only ever merges `.vars` into it afterwards, so this survives.
3. `alepha platform migrate --env production` — applies any new D1 schema
   migrations.
4. `alepha platform deploy --env production` — uploads the patched config.

## Inspecting a deployment

```bash
npx alepha platform status --env production
```

## Using Cloudflare's dashboard "Workers Builds" (git-push auto-deploy)

If instead of running commands locally you want Cloudflare to build/deploy
on every push (Workers & Pages → your project → **Settings → Build**),
set these two fields exactly — leaving the framework auto-detected (it
guesses "Hydrogen" and forces `dist/client` + `remix vite:build`, which is
wrong for this app and is exactly what was failing):

- **Build command**: `npm run build:cloudflare`
- **Deploy command**: `npx wrangler deploy --config dist/wrangler.jsonc`
- **Environment variables** (Settings → Environment variables, for the
  _Build_ step, not just runtime secrets): `CLOUDFLARE_API_TOKEN` and
  `CLOUDFLARE_ACCOUNT_ID` — `alepha platform build` needs them to look up
  the D1 database it must bind to (created once by the first `alepha
platform up` below, run locally).

The `--config` flag on the deploy command is what stops wrangler from
falling into its "no config found, let me guess your framework" wizard
(the `Detected Project Settings: Framework: Hydrogen` error) — it now
points straight at the real, already-built config instead.

You still need to run `alepha platform up --env production` **once**,
locally, before wiring this up: it's the only command that provisions the
D1 database in the first place; the dashboard's build only ever
regenerates config for resources that already exist.

## Migrations: `alepha db migrations create` is unreliable here

This project's schema-drift check (`alepha db migrations check`, and the
`migrate d1` step inside `alepha platform up`) correctly reads every
`$entity` in the app. `alepha db migrations create`, however, boots the app
through a separate script that only sees repositories that have actually
been _instantiated_ — in this app that resolves to just Alepha's own
internal `alepha_sequences` table, not `deals`, `sources`, etc. Running
`alepha db migrations create` here does **not** error, but it silently
generates a migration that drops every real table (or a migration missing
them entirely). **Do not run it.**

The current `migrations/sqlite/<timestamp>_initial_schema/` migration was
generated correctly by driving Alepha's internal `RepositoryProvider` +
`DrizzleKitProvider.generateMigration()` directly (the same code path
`migrations check` uses) instead of the buggy CLI wrapper. If the schema
changes again and a new migration is needed, ask for it to be generated
the same way rather than via `alepha db migrations create` — or verify with
`alepha db migrations check` afterwards and inspect the generated SQL
before committing (a `DROP TABLE` for an entity you didn't touch is the
tell that it picked up the same bug).

## Known limitation

Amazon and Cdiscount's collectors (`AmazonCollector.ts` /
`CdiscountCollector.ts`) use a shared `withBrowser`/`withPage` abstraction
(`src/api/collectors/browser.ts`) that transparently switches engine:

- **Locally / on a plain Node deploy** (`build.target` unset or `"bare"`):
  a local headless Chromium via `playwright`.
- **On Cloudflare Workers**: a remote browser via `@cloudflare/puppeteer`
  and the `BROWSER` binding patched in above.

Both paths share the exact same scraping logic (selectors, price parsing,
per-request fresh browser context) — only the underlying engine differs.
If Cloudflare ever changes the Browser Rendering binding's shape, or
Alepha adds first-class support for it, `browser.ts` is the only file that
needs to change.
