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
npx alepha platform plan --env cloudflare   # preview what will be created
npx alepha platform up --env cloudflare     # provisions D1/R2/KV + builds + migrates + deploys
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

1. `alepha platform build --env cloudflare` — bundles the Worker and
   (re)writes `dist/wrangler.jsonc` from the app's resource declarations.
2. `node scripts/patch-cloudflare-browser-binding.mjs` — adds
   `"browser": { "binding": "BROWSER" }` to that file. `alepha platform
deploy` only ever merges `.vars` into it afterwards, so this survives.
3. `alepha platform db migrate --env cloudflare` — applies any new D1 schema
   migrations.
4. `alepha platform deploy --env cloudflare` — uploads the patched config.

## Inspecting a deployment

```bash
npx alepha platform status --env cloudflare
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

You still need to run `alepha platform up --env cloudflare` **once**,
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

## Gotcha: Workers bundling for `playwright` / `@cloudflare/puppeteer`

Two related but opposite bugs hit this exact code path during the first
production deploy — worth knowing if collectors ever start erroring with
"No such module" again:

1. **`playwright` must never be a static top-level import.** Cloudflare
   Workers validates every static `import ... from "x"` at deploy time and
   rejects the bundle if `x` doesn't resolve — even on a code path that
   never runs there. `browser.ts` uses a dynamic `await import("playwright")`
   inside the non-Cloudflare branch of `withBrowser` instead, which is only
   resolved if actually awaited (never on Workers, since the Cloudflare
   binding branch is taken first).
2. **`@cloudflare/puppeteer` must NOT be Vite `ssr.external`.** Unlike
   `playwright`, this package genuinely needs to run inside workerd — it's
   the real Cloudflare Browser Rendering client. Marking it external (as
   `playwright`/`playwright-core` correctly are) means it's never bundled,
   so the dynamic `import("@cloudflare/puppeteer")` fails at runtime with
   the same "No such module" error, just one step later (after the
   `BROWSER` binding is found). `vite.config.ts`'s `ssr.external` list must
   contain only `playwright` and `playwright-core`, never
   `@cloudflare/puppeteer`.

Also: `CollectionService` resolves the Cloudflare browser binding via a
**getter function** passed into `AmazonCollector`/`CdiscountCollector`
(`() => this.cloudflareBrowserBinding()`), not a plain value baked into
their constructors. `CollectionService` is a long-lived singleton reused
across many Worker invocations in the same isolate — a plain value would
freeze whatever `cloudflare.env` looked like the one time the singleton
was first constructed (often `undefined`, before any request had bound
`env`), and every collection run afterwards would silently fall back to
the (non-existent-on-Workers) `playwright` path forever.

# Deploying to the OVH VPS (Bay)

**Everything in one command**, from the project on your machine:

```bash
npm run deploy:vps                      # check the VPS, verify, deploy, check again
npm run deploy:vps -- --check           # only the checks, nothing deployed
npm run deploy:vps -- --skip-verify     # without lint/types/tests
npm run deploy:vps -- --setup you@mail  # also installs Bay on a fresh VPS
```

`scripts/deploy-vps.sh` works over SSH (alias `ovh-adam`, `--host` to
change): Bay running, the runtime image set, memory raised; `npm run verify`;
`npx lore deploy`; then the release answers, the virtual display is up,
Chromium starts headless and visible, the Dealabs session is there, and how
Dealabs answers the server's address (information: its robot check is never
worked around). It reads no secret. The sections below are what it runs,
step by step.

Environment `ovh` in `alepha.config.ts`. Bay (Alepha's self-hosted app
server: reverse proxy, TLS, releases, rollback) runs on the VPS; deploys go
over SSH. Reference: https://alepha.dev/bay/docs/guides-installation.md

## One-time setup

1. **SSH alias** on the deploying machine, `~/.ssh/config`:

   ```
   Host minpricing-ovh
       HostName <VPS IP>
       User ubuntu
       IdentityFile ~/.ssh/ovh
   ```

2. **Bay on the VPS — one command from the project** (steps 2–3 below,
   done by `scripts/setup-ovh-vps.sh`; safe to run again):

   ```bash
   ssh minpricing-ovh 'bash -s' -- <you@example.com> < scripts/setup-ovh-vps.sh
   ```

   Then reconnect once (the new group is read at login). By hand instead:
   install Bay (also installs Docker), then check the host.

   ```bash
   curl -sSL https://alepha.dev/bay/install.sh | sudo sh
   sudo bay doctor
   ```

3. **systemd unit** `/etc/systemd/system/bay.service` — replace `<VPS IP>`
   and the e-mail (Let's Encrypt). Never add `PrivateTmp=yes` (secrets are
   staged in `/tmp`).

   ```ini
   [Unit]
   Description=Bay - Alepha application server
   After=network-online.target docker.service
   Wants=network-online.target

   [Service]
   Type=simple
   Restart=always
   RestartSec=2
   WorkingDirectory=/opt/bay
   RuntimeDirectory=bay
   RuntimeDirectoryMode=0755
   ExecStart=/opt/bay/bin/bay serve \
     --root /opt/bay/data \
     --base-domain <VPS IP>.sslip.io \
     --addr :80 \
     --tls --tls-addr :443 \
     --acme-email <you@example.com> \
     --control-socket /run/bay/control.sock

   [Install]
   WantedBy=multi-user.target
   ```

   ```bash
   sudo systemctl daemon-reload && sudo systemctl enable --now bay
   sudo usermod -aG bay-control ubuntu   # then log out and back in
   sudo bay status
   ```

   Firewall, if `ufw` is on: `sudo ufw allow OpenSSH && sudo ufw allow 80 && sudo ufw allow 443`.

4. **Secrets** on the deploying machine: `.env.ovh` at the project root
   (gitignored), same variables as production (`ADMIN_USERNAME`,
   `ADMIN_PASSWORD`, `AGENT_TOKEN`, `DEALABS_USERNAME`…). `APP_SECRET` and
   `DATABASE_URL` are Bay's own — don't set them.

## Deploy

```bash
npx alepha platform login --env ovh    # checks SSH, the group and Bay's socket
npm run deploy:ovh                     # npm run build + alepha platform deploy --env ovh
```

Production (Lore copy `minpricing/production`, estate `ovh-adam`) is served at
`https://minpricing.141.227.150.42.sslip.io`; deploy it with
`npx lore deploy -p minpricing -e production` (Lore keeps its secrets). The
`ovh` environment above is only for a deploy over SSH without Lore.

## Runtime image (Playwright + Chromium)

The container-based Bay runs the app in `node:22-slim` and installs nothing,
so `playwright` (the build's one external dependency) and Chromium are
missing: « Browsers: install failed — Cannot find module
'playwright/package.json' ». `docker/runtime/` is that base plus Playwright
(pinned to package.json), Chromium + headless shell with their libraries,
and Xvfb on `:99` for the visible Dealabs browser. Built and checked on the
VPS (Docker is there), pushed to ghcr.io, then given to the app:

```bash
echo <token with write:packages> | docker login ghcr.io -u <github user> --password-stdin
bash scripts/build-runtime-image.sh <github user>   # prints the line below with the digest
sudo bay runtimes set minpricing/production ghcr.io/<user>/dealradar-runtime:…@sha256:…
sudo bay harden minpricing/production --memory 1g   # restarts the app on the new image
```

There is no `bay restart`: `bay stop` then `bay start` restarts an app. Bay's
512 MB default is short for the app plus Chromium (the old VM gave it 900 MB),
hence `--memory 1g`. The image sets `DEALRADAR_BROWSERS_PREINSTALLED=1`: on
Bay's read-only root filesystem Playwright's installer hangs on its lock, so
the app only checks that Chromium is there.

Make the ghcr package public once (Bay pulls without credentials). Rebuild
and set again when Playwright's pin or the build's Node major changes.
