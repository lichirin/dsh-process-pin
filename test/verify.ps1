# dsh-process-pin - verification script (ASCII only: Windows PowerShell 5.1 reads
# BOM-less .ps1 files as ANSI, so non-ASCII here would break parsing).
#
# Opens test/mock.html (host DOM contract replica + the real plugin bundle) in
# headless Chrome, runs every scenario, and prints the assertions found in
# <div id="diag">. With -Shot it also writes one screenshot per scenario.
#
# Usage: powershell -File test/verify.ps1 [-Shot]

param(
  [switch]$Shot
)

# Keep Continue: under Stop, PS 5.1 turns native-command stderr into a terminating error.
$ErrorActionPreference = 'Continue'

$root = Split-Path -Parent $PSScriptRoot
$mock = Join-Path $root 'test\mock.html'
if (-not (Test-Path $mock)) { throw "mock page not found: $mock" }

$chrome = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $chrome) { throw 'neither Chrome nor Edge found; cannot run headless verification' }

$profile = Join-Path $env:TEMP 'dsh-process-pin-verify'
$shots = Join-Path $root 'test\shots'
New-Item -ItemType Directory -Force -Path $profile, $shots | Out-Null

# file:// URL (escape spaces)
$url = 'file:///' + ($mock -replace '\\', '/' -replace ' ', '%20')

$cases = @('ctl', 'think', 'after', 'answer', 'reup', 'deep', 'row', 'thinkonly', 'count', 'turn3')
$failed = 0

foreach ($case in $cases) {
  $target = "$url" + '?case=' + $case
  $dom = & $chrome --headless=new --disable-gpu --no-sandbox --hide-scrollbars `
    --no-first-run --no-default-browser-check --user-data-dir="$profile" `
    --window-size=1200,760 --virtual-time-budget=6000 --dump-dom $target 2>$null | Out-String

  $match = [regex]::Match($dom, '(?s)<div id="diag">(.*?)</div>')
  if (-not $match.Success) {
    Write-Output "== case=$case == no #diag found (page did not run)"
    $failed += 1
    continue
  }
  $text = $match.Groups[1].Value -replace '<[^>]+>', ''
  $text = [System.Net.WebUtility]::HtmlDecode($text).Trim()
  Write-Output "== case=$case =="
  Write-Output $text
  if ($text -notmatch 'ALL PASS') { $failed += 1 }

  if ($Shot) {
    & $chrome --headless=new --disable-gpu --no-sandbox --hide-scrollbars `
      --no-first-run --no-default-browser-check --user-data-dir="$profile" `
      --window-size=1200,760 --virtual-time-budget=6000 `
      --screenshot="$(Join-Path $shots ($case + '.png'))" $target 2>$null | Out-Null
  }
}

Write-Output ''
if ($failed -eq 0) { Write-Output "ALL $($cases.Count) CASES PASS" }
else { Write-Output "$failed CASE(S) FAILED"; exit 1 }
