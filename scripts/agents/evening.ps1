# DealRadar evening run — Windows Task Scheduler, every day at 17:00.
#  Mon–Fri: selection (Sonnet) → random plan + publishing (Node, no tokens)
#           → Notion plan log, then final log (Haiku)
#  Saturday: Notion temperature refresh only (Haiku)
#  Sunday:   weekly review (Sonnet), code proposal if any, then refresh
#  Every day: deals-sources (Sonnet) compares what each deal source yields
#  with what goes hot on Dealabs, tunes config/collection.json (how often
#  each source runs, unproductive ones off, Amazon/Cdiscount pages), probes
#  new shops and writes source proposals — while the publications wait
#  Every day, last: deals-debrief (Sonnet) reviews our Dealabs profile and
#  comments, adjusts config/selection-lessons.md, desirability.json and
#  small steps of publish-rules.json, reports to Notion
# Logs: data/agents/evening-<date>.log

$ErrorActionPreference = "Continue"
# Claude and Node write UTF-8: without this, accents come out garbled in the log.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
$root = Resolve-Path (Join-Path $PSScriptRoot "..\..")
Set-Location $root
$today = Get-Date -Format "yyyy-MM-dd"
$dir = Join-Path $root "data\agents"
New-Item -ItemType Directory -Force $dir | Out-Null
$log = Join-Path $dir "evening-$today.log"
function Log($message) { "$(Get-Date -Format 'HH:mm:ss') $message" | Out-File -Append -Encoding utf8 $log }

# Claude Code CLI: on PATH, else the binary bundled with the VS Code extension (newest).
$claude = (Get-Command claude -ErrorAction SilentlyContinue).Source
if (-not $claude) {
  $claude = Get-ChildItem "$env:USERPROFILE\.vscode\extensions" -Directory -Filter "anthropic.claude-code-*" -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending |
    ForEach-Object { Join-Path $_.FullName "resources\native-binary\claude.exe" } |
    Where-Object { Test-Path $_ } | Select-Object -First 1
}
if (-not $claude) { Log "ERREUR: claude.exe introuvable"; exit 1 }

# A dev server stuck after a code reload ("Dev server has no app loaded")
# still holds its port but answers 500: kill it so it gets restarted.
try {
  Invoke-WebRequest -UseBasicParsing -Uri "http://localhost:5173/api/auth/login" -Method Post -ContentType "application/json" `
    -Body '{"username":"x","password":"x"}' -TimeoutSec 20 | Out-Null
} catch {
  $code = $_.Exception.Response.StatusCode.value__
  if ($code -ge 500) {
    Log "serveur bloqué (HTTP $code) : redémarrage"
    Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
      Where-Object { $_.CommandLine -match 'alepha.*\bdev\b|npm-cli\.js" run dev' } |
      ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
    Start-Sleep -Seconds 3
  }
}
$server = node scripts/agents/dealradar.mjs ensure-server 2>&1
Log "server: $server"
if ($server -notmatch '"running":true') { Log "ERREUR: serveur DealRadar injoignable"; exit 1 }

$notion = "mcp__claude_ai_Notion__notion-fetch,mcp__claude_ai_Notion__notion-query-data-sources,mcp__claude_ai_Notion__notion-create-pages,mcp__claude_ai_Notion__notion-update-page"
$bridge = "Bash(node scripts/agents/dealradar.mjs:*)"
function Claude($prompt, $model, $tools, $extra = @()) {
  Log "== $prompt ($model) =="
  & $claude -p $prompt --model $model --permission-mode acceptEdits --allowedTools $tools @extra 2>&1 |
    Where-Object { "$_" -notmatch 'SEP-2352|issuer' } | Out-File -Append -Encoding utf8 $log
}

$day = [int](Get-Date).DayOfWeek   # 0 = Sunday, 6 = Saturday
if ($day -eq 0) {
  Claude "/deals-weekly" "sonnet" "Read,Write,Edit,$bridge,$notion"
  if (Get-ChildItem $dir -Filter "code-proposal-*.md" | Where-Object { $_.Name -notmatch '-done' }) {
    Claude "/deals-code" "sonnet" "Agent,Read,Glob,Grep,Write,Edit,$bridge,Bash(git:*),Bash(npm run:*),Bash(npx alepha:*),Bash(cmd /c mklink:*),$notion" @("--disallowedTools", "Bash(git push:*)", "--add-dir", (Join-Path $root "..\minpricing-agents"))
  }
}

$sourcesTools = "Read,Write,Edit,Glob,$bridge,$notion"
$sourcesDone = $false
$alreadyDone = Test-Path (Join-Path $dir "published-$today.json")
if ($alreadyDone) { Log "publications du jour déjà faites (published-$today.json) : pas de nouvelle sélection" }
if ($day -ge 1 -and $day -le 5 -and -not $alreadyDone) {
  Claude "/deals-select" "sonnet" "Read,Write,$bridge,$notion"
  $queue = Join-Path $dir "queue-$today.json"
  if (Test-Path $queue) {
    Log "== publish-queue =="
    $plan = Join-Path $dir "plan-$today.json"
    Remove-Item $plan -ErrorAction SilentlyContinue
    $publisher = Start-Process node -ArgumentList "scripts/agents/dealradar.mjs", "publish-queue", "`"$queue`"" -NoNewWindow -PassThru `
      -RedirectStandardOutput (Join-Path $dir "publish-$today.out") -RedirectStandardError (Join-Path $dir "publish-$today.err")
    for ($i = 0; $i -lt 60 -and -not (Test-Path $plan); $i++) { Start-Sleep -Seconds 2 }
    if (Test-Path $plan) { Log "plan: $(Get-Content $plan -Raw)"; Claude "/deals-log plan" "haiku" "Read,$bridge,$notion" }
    # The posts wait for their random times (17:30-21:30): review the
    # sources meanwhile.
    Claude "/deals-sources" "sonnet" $sourcesTools
    $sourcesDone = $true
    $publisher.WaitForExit()
    Log "publish-queue terminé (code $($publisher.ExitCode))"
  } else {
    Log "pas de file de publication (désactivé ou rien d'éligible)"
  }
}

if (-not $sourcesDone) { Claude "/deals-sources" "sonnet" $sourcesTools }
Claude "/deals-log final" "haiku" "Read,$bridge,$notion"
# Every day, after publishing: review our Dealabs profile (temperatures,
# comments), adjust lessons / desirability / small rule steps,
# and write the analysis to Notion.
Claude "/deals-debrief" "sonnet" "Read,Write,Edit,$bridge,$notion"
Log "fin"
