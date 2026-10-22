# Re-run only the publishing part of tonight's DealRadar run (after a fix,
# or if the evening task was stopped): publish today's queue at its
# remaining slots, then log the outcomes to Notion.
$ErrorActionPreference = "Continue"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
$root = Resolve-Path (Join-Path $PSScriptRoot "..\..")
Set-Location $root
$today = Get-Date -Format "yyyy-MM-dd"
$log = Join-Path $root "data\agents\evening-$today.log"
function Log($message) { "$(Get-Date -Format 'HH:mm:ss') $message" | Out-File -Append -Encoding utf8 $log }

$claude = (Get-Command claude -ErrorAction SilentlyContinue).Source
if (-not $claude) {
  $claude = Get-ChildItem "$env:USERPROFILE\.vscode\extensions" -Directory -Filter "anthropic.claude-code-*" -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending |
    ForEach-Object { Join-Path $_.FullName "resources\native-binary\claude.exe" } |
    Where-Object { Test-Path $_ } | Select-Object -First 1
}
$notion = "mcp__claude_ai_Notion__notion-fetch,mcp__claude_ai_Notion__notion-query-data-sources,mcp__claude_ai_Notion__notion-create-pages,mcp__claude_ai_Notion__notion-update-page"

Log "== publish-queue (relance) =="
node scripts/agents/dealradar.mjs publish-queue (Join-Path $root "data\agents\queue-$today.json") 2>&1 | Out-File -Append -Encoding utf8 $log
if ($claude) {
  Log "== deals-log =="
  & $claude -p "/deals-log final" --model haiku --allowedTools "Read,Bash(node scripts/agents/dealradar.mjs:*),$notion" 2>&1 | Out-File -Append -Encoding utf8 $log
}
Log "fin (relance)"
