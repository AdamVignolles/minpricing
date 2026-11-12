#!/usr/bin/env bash
# DealRadar on the OVH VPS, in one go — run from the project, on your machine:
#
#   npm run deploy:vps                      # check, image, build, deploy, check again
#   npm run deploy:vps -- --check           # only the checks, nothing changed
#   npm run deploy:vps -- --skip-verify     # without lint/typecheck/tests
#   npm run deploy:vps -- --image           # rebuild the runtime image even if current
#   npm run deploy:vps -- --setup you@mail  # also installs Bay on a fresh VPS
#
# Everything on the VPS goes through SSH (alias in ~/.ssh/config, default
# `ovh-adam`; DEALRADAR_VPS_HOST or --host to change). The deploy itself is
# Lore's (`npx lore deploy`), which keeps the app's secrets: none is read,
# printed or copied by this script. Full walk-through: DEPLOY.md, « Everything
# in one command ».
#
# Steps:
#   1. your machine: SSH reachable, what is about to be deployed
#   2. the VPS: Bay running (installed with --setup)
#   3. the runtime image (docker/runtime: Node + Playwright + Chromium + Xvfb):
#      built on the VPS when it is missing or out of date, checked (Chromium
#      starts headless and visible as the app's user), pushed to ghcr.io and
#      set on the app with its digest; memory and process limits raised
#   4. npm run verify (lint, types, tests, migrations, build)
#   5. npx lore deploy — the app restarts on the new release and image
#   6. the VPS again: the release answers, it runs the image just set, the
#      virtual display is up, Chromium starts, the Dealabs session is there
#   7. for information: how Dealabs answers this server (its robot check is
#      never worked around — see CLAUDE.md, « Robot check »)
#
# The image is pushed with the VPS's own `docker login ghcr.io` (root). With
# none, pass a GitHub token that has `write:packages` once:
#   GHCR_TOKEN=<token> npm run deploy:vps
# It goes to `docker login --password-stdin` over SSH, never on a command line.
set -euo pipefail

HOST="${DEALRADAR_VPS_HOST:-ovh-adam}"
PROJECT="${LORE_PROJECT:-minpricing}"
ENVIRONMENT="${LORE_ENV:-production}"
MEMORY="2g"
PIDS="2048"
SKIP_VERIFY=0
CHECK_ONLY=0
FORCE_IMAGE=0
OWNER="${GHCR_OWNER:-}"
SETUP_EMAIL=""

while [ $# -gt 0 ]; do
  case "$1" in
    --host) HOST="$2"; shift 2 ;;
    --env) ENVIRONMENT="$2"; shift 2 ;;
    --setup) SETUP_EMAIL="$2"; shift 2 ;;
    --skip-verify) SKIP_VERIFY=1; shift ;;
    --check) CHECK_ONLY=1; shift ;;
    --image) FORCE_IMAGE=1; shift ;;
    --owner) OWNER="$2"; shift 2 ;;
    -h | --help) sed -n '2,34p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $1 (--help)" >&2; exit 2 ;;
  esac
done

APP="${PROJECT}/${ENVIRONMENT}"
CONTAINER="bay-${PROJECT}-${ENVIRONMENT}"
DATA="/opt/bay/data/apps/${PROJECT}-${ENVIRONMENT}/data"
cd "$(dirname "$0")/.."

step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
ok() { printf '    \033[32mok\033[0m    %s\n' "$*"; }
warn() { printf '    \033[33mwarn\033[0m  %s\n' "$*"; WARNINGS=$((WARNINGS + 1)); }
die() { printf '    \033[31mfail\033[0m  %s\n' "$*" >&2; exit 1; }
remote() { ssh -o BatchMode=yes -o ConnectTimeout=15 "$HOST" "$@"; }
WARNINGS=0

# ── 1. This machine ─────────────────────────────────────────────────────────
step "This machine"
remote true 2>/dev/null || die "SSH to « $HOST » failed: add the alias to ~/.ssh/config (HostName, User, IdentityFile)"
ok "SSH to $HOST"
ok "deploying $(git rev-parse --abbrev-ref HEAD) @ $(git rev-parse --short HEAD) to $APP"
[ -z "$(git status --porcelain)" ] || warn "uncommitted changes are part of this deploy"

# ── 2. The VPS ──────────────────────────────────────────────────────────────
step "The VPS"
if ! remote 'command -v bay >/dev/null && systemctl is-active --quiet bay'; then
  [ -n "$SETUP_EMAIL" ] || die "Bay is not running on $HOST: run again with --setup <e-mail for certificates>"
  step "Installing Bay (scripts/setup-ovh-vps.sh)"
  remote 'bash -s' -- "$SETUP_EMAIL" <scripts/setup-ovh-vps.sh
fi
ok "Bay is running"

# ── 3. Runtime image ────────────────────────────────────────────────────────
# What the image must be: docker/runtime as it is here, Playwright as pinned
# in package.json, and the Node major this machine builds for (Bay records
# it in the release's manifest.json → runtimeVersion).
PW="$(node -p 'require("./package.json").dependencies.playwright.replace(/^[^0-9]*/, "")')"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
WANT="$( (cat docker/runtime/Dockerfile docker/runtime/entrypoint.sh; echo "$PW $NODE_MAJOR") | sha256sum | cut -c1-12)"

bay_status() { remote "sudo -n bay status 2>&1" || true; } # non-zero on its own warnings
app_exists() { bay_status | grep -q "^${APP}\$"; }
current_runtime() { bay_status | awk -v app="$APP" '$0==app{f=1} f&&$1=="runtime"{print $2; exit}'; }

ensure_image() {
  step "Runtime image (Node $NODE_MAJOR, Playwright $PW, Chromium, Xvfb)"
  local runtime have
  runtime="$(current_runtime)"
  case "$runtime" in *dealradar-runtime*) ;; *) runtime="" ;; esac
  have=""
  if [ -n "$runtime" ]; then
    have="$(remote "sudo -n docker inspect --format '{{index .Config.Labels \"dealradar.runtime.hash\"}}' '$runtime' 2>/dev/null" || true)"
  fi
  if [ -n "$runtime" ] && [ "$have" = "$WANT" ] && [ "$FORCE_IMAGE" = 0 ]; then
    ok "up to date ($WANT): ${runtime##*/}"
    return 0
  fi
  if [ "$CHECK_ONLY" = 1 ]; then
    if [ -n "$runtime" ]; then
      warn "the image is out of date (wanted $WANT, found ${have:-an unlabelled one}): a deploy rebuilds it"
    else
      warn "no runtime image on $APP: a deploy builds it"
    fi
    return 0
  fi

  # Whose ghcr.io namespace: the image already set, else the GitHub remote.
  if [ -z "$OWNER" ] && [ -n "$runtime" ]; then OWNER="$(printf '%s' "$runtime" | cut -d/ -f2)"; fi
  if [ -z "$OWNER" ]; then OWNER="$(git remote get-url origin | sed -E 's#.*github\.com[:/]([^/]+)/.*#\1#')"; fi
  OWNER="$(printf '%s' "$OWNER" | tr '[:upper:]' '[:lower:]')"
  [ -n "$OWNER" ] || die "no GitHub owner for ghcr.io: --owner <github user>"
  local repo="ghcr.io/${OWNER}/dealradar-runtime"
  local tag="${repo}:node${NODE_MAJOR}-pw${PW}-${WANT}"

  # The registry login comes first: no point building 1.8 GB that can't be pushed.
  if [ -n "${GHCR_TOKEN:-}" ]; then
    printf '%s' "$GHCR_TOKEN" | remote "sudo -n docker login ghcr.io -u '$OWNER' --password-stdin" >/dev/null ||
      die "ghcr.io refused the token (it needs write:packages)"
  fi
  remote "sudo -n docker login ghcr.io </dev/null >/dev/null 2>&1" ||
    die "the VPS is not logged in to ghcr.io: run once with GHCR_TOKEN=<GitHub token with write:packages>"
  ok "ghcr.io login on the VPS"

  echo "    building $tag on the VPS (a few minutes the first time)"
  tar -C docker/runtime -cf - . |
    remote 'rm -rf /tmp/dealradar-runtime && mkdir -p /tmp/dealradar-runtime && tar -C /tmp/dealradar-runtime -xf -'
  remote "sudo -n docker build --quiet \
      --build-arg NODE_MAJOR=$NODE_MAJOR --build-arg PLAYWRIGHT_VERSION=$PW \
      --label dealradar.runtime.hash=$WANT -t '$tag' /tmp/dealradar-runtime" >/dev/null ||
    die "docker build failed: ssh $HOST, then \`sudo docker build /tmp/dealradar-runtime\` shows why"
  ok "built"

  # As Bay runs it: uid 20000, read-only root, the entrypoint's Xvfb.
  remote "sudo -n docker run --rm --user 20000:20000 --read-only --tmpfs /tmp:exec,mode=1777 -e HOME=/tmp -w /opt/playwright '$tag' node -e '
    const { chromium } = require(\"playwright\");
    (async () => {
      for (const headless of [true, false]) {
        const b = await chromium.launch({ headless, args: [\"--disable-crash-reporter\"] });
        const p = await b.newPage();
        await p.setContent(\"<title>ok</title>\");
        console.log(headless ? \"headless\" : \"visible\", await p.title());
        await b.close();
      }
    })().catch((e) => { console.error(String(e).split(\"\\n\")[0]); process.exit(1); });
  '" 2>&1 | grep -q "visible ok" ||
    die "Chromium does not start in the new image: nothing was pushed, the app keeps its current image"
  ok "Chromium starts in it, headless and visible, as the app's user"

  remote "sudo -n docker push --quiet '$tag'" >/dev/null || die "docker push failed"
  local digest
  digest="$(remote "sudo -n docker inspect --format '{{index .RepoDigests 0}}' '$tag'")"
  [ -n "$digest" ] || die "no digest for $tag after the push"
  ok "pushed ${digest##*/}"

  # Bay pulls without credentials: the package must be public.
  local token code
  token="$(curl -s -m 15 "https://ghcr.io/token?service=ghcr.io&scope=repository:${OWNER}/dealradar-runtime:pull" | sed -E 's/.*"token":"([^"]+)".*/\1/' || true)"
  code="$(curl -s -o /dev/null -m 15 -w '%{http_code}' -H "Authorization: Bearer $token" \
    -H 'Accept: application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.manifest.v1+json' \
    "https://ghcr.io/v2/${OWNER}/dealradar-runtime/manifests/${digest##*@}" || true)"
  [ "$code" = 200 ] ||
    warn "ghcr.io does not serve the image anonymously ($code): make the package public (GitHub → Packages → dealradar-runtime → Package settings → Change visibility), or a new VPS could not pull it"

  remote "sudo -n bay runtimes set '$APP' '$digest'" >/dev/null || die "bay runtimes set failed"
  ok "set on $APP (used from the app's next start)"
  IMAGE_CHANGED=1
}

ensure_limits() {
  if bay_status | awk -v app="$APP" '$0==app{f=1;next} f&&/^[^ ]/{exit} f' | grep -q 'set by bay harden --memory'; then
    ok "memory and process limits raised"
  elif [ "$CHECK_ONLY" = 1 ]; then
    warn "memory is Bay's default (512 MiB, too little for the app plus Chromium): a deploy raises it to $MEMORY"
  else
    # Restarts the app, on the image set above.
    remote "sudo -n bay harden '$APP' --memory $MEMORY --pids $PIDS" >/dev/null
    ok "memory raised to $MEMORY, processes to $PIDS (Bay's 512 MiB default is too little for Chromium)"
    IMAGE_CHANGED=0
  fi
}

IMAGE_CHANGED=0
FRESH_APP=0
if app_exists; then
  ensure_image
  ensure_limits
  bay_status | awk -v app="$APP" '$0==app{f=1;next} f&&/^[^ ]/{exit} f' | grep -q 'backup   NEVER' &&
    warn "no backup of the database has ever run (\`bay config s3\` on the VPS)"
else
  FRESH_APP=1
  ok "$APP does not exist yet: the deploy creates it, the image is set right after"
fi

# ── 4 and 5. Verify, deploy ─────────────────────────────────────────────────
if [ "$CHECK_ONLY" = 0 ]; then
  if [ "$SKIP_VERIFY" = 0 ]; then
    step "npm run verify"
    npm run verify >/tmp/dealradar-verify.log 2>&1 || {
      grep -E "FAIL|error" /tmp/dealradar-verify.log | sort -u | head -20
      die "verify failed (full output: /tmp/dealradar-verify.log) — nothing was deployed"
    }
    ok "lint, types, tests, migrations, build"
  fi
  step "Deploy (Lore → Bay)"
  npx lore deploy -p "$PROJECT" -e "$ENVIRONMENT" 2>&1 | grep -E "Pushed|Deploying|reports|Deployed|rror" || die "lore deploy failed (not logged in? \`npx lore login\`)"
fi

# A new app: now that the deploy created it, give it its image and limits
# (`bay harden` restarts it on that image).
if [ "$FRESH_APP" = 1 ] && [ "$CHECK_ONLY" = 0 ]; then
  ensure_image
  ensure_limits
  [ "$IMAGE_CHANGED" = 0 ] || { remote "sudo -n bay stop '$APP' && sudo -n bay start '$APP'" >/dev/null; }
fi

# ── 6. The VPS, after ───────────────────────────────────────────────────────
step "After the deploy"
# `bay status` exits non-zero when it has warnings of its own (backups…).
DOMAIN="$( (remote "sudo -n bay status 2>&1" || true) | awk -v app="$APP" '$0==app{f=1} f&&$1=="domain"{print $2; exit}')"
[ -n "$DOMAIN" ] || die "$APP is not listed by \`bay status\`"
CODE=000
for _ in $(seq 1 30); do
  CODE="$(curl -s -o /dev/null -m 10 -w '%{http_code}' "https://${DOMAIN}/" || true)"
  [ "$CODE" = 200 ] && break
  sleep 2
done
[ "$CODE" = 200 ] || die "https://${DOMAIN}/ answers $CODE after a minute: \`ssh $HOST sudo docker logs --tail 80 $CONTAINER\`"
ok "https://${DOMAIN}/ answers 200"
ok "release $(remote "sudo -n readlink /opt/bay/data/apps/${PROJECT}-${ENVIRONMENT}/current" | sed 's#releases/##')"

# The container really runs the image set on the app, with the versions wanted.
RUNNING="$(remote "sudo -n docker inspect --format '{{.Image}}' $CONTAINER 2>/dev/null" || true)"
SET_ID="$(remote "sudo -n docker inspect --format '{{.Id}}' '$(current_runtime)' 2>/dev/null" || true)"
if [ -n "$RUNNING" ] && [ "$RUNNING" = "$SET_ID" ]; then
  ok "the app runs the image set on it"
else
  warn "the app's container is not on the image set on it yet (\`ssh $HOST sudo bay stop $APP && sudo bay start $APP\`)"
fi
VERSIONS="$(remote "sudo -n docker exec $CONTAINER node -p 'process.versions.node.split(\".\")[0] + \" \" + require(\"/opt/playwright/node_modules/playwright/package.json\").version'" 2>/dev/null || true)"
[ "$VERSIONS" = "$NODE_MAJOR $PW" ] && ok "Node $NODE_MAJOR and Playwright $PW in the container" ||
  warn "the container has Node/Playwright « $VERSIONS », the build wants « $NODE_MAJOR $PW »"

remote "sudo -n docker exec $CONTAINER sh -c 'test -e /tmp/.X11-unix/X\${DISPLAY#:}'" 2>/dev/null &&
  ok "virtual display is up (the « écran distant » can show the Dealabs window)" ||
  warn "no virtual display in the container: the Dealabs login and robot check can't be shown"

# A real Chromium start, headless (collectors) and visible (Dealabs), as the app's user.
BROWSERS="$(remote "sudo -n docker exec -w /opt/playwright -e HOME=/tmp -e PLAYWRIGHT_BROWSERS_PATH=/ms-playwright $CONTAINER node -e '
  const { chromium } = require(\"playwright\");
  (async () => {
    for (const headless of [true, false]) {
      const b = await chromium.launch({ headless, args: [\"--disable-crash-reporter\"] });
      const p = await b.newPage();
      await p.setContent(\"<title>ok</title>\");
      console.log(headless ? \"headless\" : \"visible\", await p.title());
      await b.close();
    }
  })().catch((e) => { console.error(String(e).split(\"\\n\")[0]); process.exit(1); });
' 2>&1" || true)"
if printf '%s' "$BROWSERS" | grep -q "visible ok"; then
  ok "Chromium starts, headless and visible"
else
  warn "Chromium did not start: $(printf '%s' "$BROWSERS" | tail -1)"
fi

SESSION="$(remote "sudo -n stat -c %y $DATA/.dealabs-session.json 2>/dev/null | cut -c1-16" || true)"
[ -n "$SESSION" ] && ok "Dealabs session saved $SESSION UTC" ||
  warn "no Dealabs session: « Se reconnecter » on a deal page, then log in in the « écran distant »"

# ── 7. Dealabs' view of this server (information) ───────────────────────────
step "Dealabs, from this server"
DEALABS="$(remote "curl -s -4 -m 15 -o /dev/null -w '%{http_code}' -A 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36' https://www.dealabs.com/bons-plans" || true)"
case "$DEALABS" in
  200) ok "Dealabs serves this server's address normally" ;;
  403) warn "Dealabs answers this server's address with its robot check (403): publishing waits for a person to pass it in the « écran distant », and Dealabs' price history may be unreadable from here" ;;
  *) warn "Dealabs answered $DEALABS" ;;
esac

echo
if [ "$WARNINGS" = 0 ]; then
  printf '\033[32mDone, everything is in place:\033[0m https://%s/\n' "$DOMAIN"
else
  printf '\033[33mDone, with %s warning(s) above:\033[0m https://%s/\n' "$WARNINGS" "$DOMAIN"
fi
