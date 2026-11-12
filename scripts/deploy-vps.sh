#!/usr/bin/env bash
# DealRadar on the OVH VPS, in one go — run from the project, on your machine:
#
#   npm run deploy:vps                      # check, build, deploy, check again
#   npm run deploy:vps -- --skip-verify     # without lint/typecheck/tests
#   npm run deploy:vps -- --setup you@mail  # also installs Bay on a fresh VPS
#   npm run deploy:vps -- --check           # only the checks, nothing deployed
#
# Everything on the VPS goes through SSH (alias in ~/.ssh/config, default
# `ovh-adam`; DEALRADAR_VPS_HOST or --host to change). The deploy itself is
# Lore's (`npx lore deploy`), which keeps the app's secrets: none is read,
# printed or copied by this script.
#
# Steps:
#   1. your machine: SSH reachable, what is about to be deployed
#   2. the VPS: Bay running (installed with --setup), the runtime image with
#      Chromium + Xvfb set on the app, memory and process limits raised
#   3. npm run verify (lint, types, tests, migrations, build)
#   4. npx lore deploy
#   5. the VPS again: the new release answers, the virtual display is up,
#      Chromium starts headless and visible, the Dealabs session is there
#   6. for information: how Dealabs answers this server (its robot check is
#      never worked around — see CLAUDE.md, « Robot check »)
set -euo pipefail

HOST="${DEALRADAR_VPS_HOST:-ovh-adam}"
PROJECT="${LORE_PROJECT:-minpricing}"
ENVIRONMENT="${LORE_ENV:-production}"
MEMORY="2g"
PIDS="2048"
SKIP_VERIFY=0
CHECK_ONLY=0
SETUP_EMAIL=""

while [ $# -gt 0 ]; do
  case "$1" in
    --host) HOST="$2"; shift 2 ;;
    --env) ENVIRONMENT="$2"; shift 2 ;;
    --setup) SETUP_EMAIL="$2"; shift 2 ;;
    --skip-verify) SKIP_VERIFY=1; shift ;;
    --check) CHECK_ONLY=1; shift ;;
    -h | --help) sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
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

# ── 2. The VPS, before ──────────────────────────────────────────────────────
step "The VPS"
if ! remote 'command -v bay >/dev/null && systemctl is-active --quiet bay'; then
  [ -n "$SETUP_EMAIL" ] || die "Bay is not running on $HOST: run again with --setup <e-mail for certificates>"
  step "Installing Bay (scripts/setup-ovh-vps.sh)"
  remote 'bash -s' -- "$SETUP_EMAIL" <scripts/setup-ovh-vps.sh
fi
ok "Bay is running"

STATUS="$(remote "sudo -n bay status 2>&1" || true)"
if printf '%s' "$STATUS" | grep -q "^${APP}\$"; then
  if printf '%s' "$STATUS" | grep -q 'runtime .*dealradar-runtime'; then
    ok "runtime image with Chromium and Xvfb is set"
  else
    die "no runtime image on $APP: build it once (bash scripts/build-runtime-image.sh <github user>, DEPLOY.md « Runtime image »), then \`sudo bay runtimes set $APP <digest>\`"
  fi
  if printf '%s' "$STATUS" | grep -q 'memory .*default is 512)' && ! printf '%s' "$STATUS" | grep -q 'set by bay harden --memory'; then
    [ "$CHECK_ONLY" = 1 ] || remote "sudo -n bay harden $APP --memory $MEMORY --pids $PIDS"
    warn "memory was Bay's default (512 MiB, too little for Chromium): raised to $MEMORY"
  else
    ok "memory and process limits raised"
  fi
  printf '%s' "$STATUS" | grep -q 'backup   NEVER' && warn "no backup of the database has ever run (\`bay config s3\` on the VPS)"
else
  warn "$APP does not exist on the VPS yet: this deploy creates it; set its runtime image afterwards (DEPLOY.md « Runtime image ») and run this script again"
fi

# ── 3 and 4. Verify, deploy ─────────────────────────────────────────────────
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

# ── 5. The VPS, after ───────────────────────────────────────────────────────
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

# ── 6. Dealabs' view of this server (information) ───────────────────────────
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
