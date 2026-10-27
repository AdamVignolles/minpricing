#!/usr/bin/env bash
# DealRadar evening run on the Bay VM (Linux port of evening.ps1), started by
# the systemd timer dealradar-agents.timer at 17:00 Paris time.
#  Mon-Fri: selection -> random plan + publishing (Node, no tokens) -> Notion
#           plan log, then final log
#  Saturday: Notion temperature refresh only
#  Sunday:   weekly review, code proposal if any, then refresh
#  Every day: deals-sources while the posts wait, then deals-debrief last
# Runs in APP_FILES_DIR (holds scripts/, .claude/, config/, docs/, data/agents).
# Logs: data/agents/evening-<date>.log

set -u
export TZ=Europe/Paris
export PATH="/opt/bay/runtimes/node-26/bin:$HOME/.local/claude/bin:$PATH"
ROOT="${DEALRADAR_ROOT:-/opt/bay/data/apps/minpricing-bay/data}"
cd "$ROOT" || exit 1
TODAY=$(date +%F)
DIR="$ROOT/data/agents"
mkdir -p "$DIR"
LOG="$DIR/evening-$TODAY.log"
log() { echo "$(date +%H:%M:%S) $*" >>"$LOG"; }

if ! command -v claude >/dev/null; then log "ERREUR: claude introuvable"; exit 1; fi

# The agents read the database read-only: work on a fresh copy, since the
# live file belongs to the app's service user.
snapshot() {
  local db=/opt/bay/data/apps/minpricing-bay/data
  sudo -n cp "$db/app.db" "$DIR/app-snapshot.db" 2>>"$LOG" &&
    { [ ! -f "$db/app.db-wal" ] || sudo -n cp "$db/app.db-wal" "$DIR/app-snapshot.db-wal"; } &&
    sudo -n chown "$(id -u):$(id -g)" "$DIR"/app-snapshot.db* && chmod 600 "$DIR"/app-snapshot.db*
}
snapshot || log "avertissement: copie de la base impossible"

server=$(node scripts/agents/dealradar.mjs ensure-server 2>&1)
log "server: $server"
case "$server" in *'"running":true'*) ;; *) log "ERREUR: serveur DealRadar injoignable"; exit 1 ;; esac

NOTION="mcp__claude_ai_Notion__notion-fetch,mcp__claude_ai_Notion__notion-query-data-sources,mcp__claude_ai_Notion__notion-create-pages,mcp__claude_ai_Notion__notion-update-page"
BRIDGE="Bash(node scripts/agents/dealradar.mjs:*)"
claude_run() { # prompt model tools [extra args...]
  local prompt=$1 model=$2 tools=$3
  shift 3
  log "== $prompt ($model) =="
  claude -p "$prompt" --model "$model" --permission-mode acceptEdits --allowedTools "$tools" "$@" 2>&1 |
    grep -Ev 'SEP-2352|issuer' >>"$LOG"
}

DAY=$(date +%w) # 0 = Sunday, 6 = Saturday
if [ "$DAY" -eq 0 ]; then
  claude_run "/deals-weekly" sonnet "Read,Write,Edit,$BRIDGE,$NOTION"
fi

SOURCES_TOOLS="Read,Write,Edit,Glob,$BRIDGE,$NOTION"
sources_done=0
already_done=0
if [ -f "$DIR/published-$TODAY.json" ]; then
  already_done=1
  log "publications du jour déjà faites (published-$TODAY.json) : pas de nouvelle sélection"
fi
if [ "$DAY" -ge 1 ] && [ "$DAY" -le 5 ] && [ "$already_done" -eq 0 ]; then
  claude_run "/deals-select" sonnet "Read,Write,$BRIDGE,$NOTION"
  QUEUE="$DIR/queue-$TODAY.json"
  if [ -f "$QUEUE" ]; then
    log "== publish-queue =="
    PLAN="$DIR/plan-$TODAY.json"
    rm -f "$PLAN"
    node scripts/agents/dealradar.mjs publish-queue "$QUEUE" >"$DIR/publish-$TODAY.out" 2>"$DIR/publish-$TODAY.err" &
    PUB=$!
    for _ in $(seq 60); do [ -f "$PLAN" ] && break; sleep 2; done
    if [ -f "$PLAN" ]; then
      log "plan: $(cat "$PLAN")"
      claude_run "/deals-log plan" haiku "Read,$BRIDGE,$NOTION"
    fi
    # The posts wait for their random times: review the sources meanwhile.
    claude_run "/deals-sources" sonnet "$SOURCES_TOOLS"
    sources_done=1
    wait "$PUB"
    log "publish-queue terminé (code $?)"
  else
    log "pas de file de publication (désactivé ou rien d'éligible)"
  fi
fi

[ "$sources_done" -eq 1 ] || claude_run "/deals-sources" sonnet "$SOURCES_TOOLS"
claude_run "/deals-log final" haiku "Read,$BRIDGE,$NOTION"
snapshot
claude_run "/deals-debrief" sonnet "Read,Write,Edit,$BRIDGE,$NOTION"
log "fin"
