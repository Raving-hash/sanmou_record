# One scheduled run of rank-shot.js, with a log file.
#
# install-rank-task.ps1 points the scheduled task at THIS script rather than at
# node directly, because a task has no console: if node died on "window not
# found" there would be nothing left to look at. Every run here writes
#   data\rank-shots\logs\run-<stamp>.log     full stdout+stderr of that run
#   data\rank-shots\logs\runs.log            one summary line per run
# and the last of those is the file to tail when something looks wrong.
#
#   .\scripts\run-rank-shot.ps1 -ScoreGrow 100 -Prune 6      # what the task runs
#   .\scripts\run-rank-shot.ps1 -NoPost                     # grab + OCR, send nothing
#
# ASCII only: Windows PowerShell 5.1 reads .ps1 as ANSI.
param(
  [string]$RepoPath = '',
  [string]$NodePath = '',
  [int]$Frames = 18,
  [int]$Notches = 4,
  [string]$Title = '',
  [int]$ScoreGrow = 0,
  [int]$ScoreAdd = 0,
  [int]$Prune = 0,
  [string]$Post = '',
  [string]$Token = '',
  # The game's process name, so a run when the game is closed is skipped quietly
  # instead of spending three minutes failing to find a window.
  [string]$ProcessName = 'com.bilibili.nslg',
  [switch]$NoNavigate,
  [switch]$NoPost
)

$ErrorActionPreference = 'Stop'

if (-not $RepoPath) { $RepoPath = Split-Path $PSScriptRoot -Parent }
$script = Join-Path $RepoPath 'scripts\rank-shot.js'
if (-not (Test-Path $script)) { throw "rank-shot.js not found under $RepoPath" }

# node: explicit > tools\node.exe in the repo > PATH. The repo copy exists so the
# task does not depend on some other installed runtime being kept around.
if (-not $NodePath) {
  $local = Join-Path $RepoPath 'tools\node.exe'
  if (Test-Path $local) { $NodePath = $local }
}
if (-not $NodePath) {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { $NodePath = $cmd.Source }
}
if (-not $NodePath -or -not (Test-Path $NodePath)) {
  throw 'node.exe not found. Put one at tools\node.exe or pass -NodePath'
}

$logDir = Join-Path $RepoPath 'data\rank-shots\logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$stamp = Get-Date -Format 'yyyy-MM-dd-HHmm'
$log = Join-Path $logDir "run-$stamp.log"
$err = Join-Path $logDir "run-$stamp.err.log"
$history = Join-Path $logDir 'runs.log'

function Note([string]$line) {
  $ts = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
  Add-Content -Path $history -Value "$ts $line" -Encoding UTF8
}

# Game not running -> nothing to grab. Exit 0: this is not a failure, and the
# task should not start shouting once a night's worth of runs piles up.
if ($ProcessName) {
  $proc = Get-Process -Name $ProcessName -ErrorAction SilentlyContinue
  if (-not $proc) {
    Note 'skip: game not running'
    Write-Output 'skip: game not running'
    exit 0
  }
}

$argList = @($script, '--capture', '--frames', "$Frames", '--notches', "$Notches")
if ($Title) { $argList += @('--title', $Title) }
if ($Post) { $argList += @('--post', $Post) }
if ($Token) { $argList += @('--token', $Token) }
if ($ScoreGrow) { $argList += @('--score-grow', "$ScoreGrow") }
if ($ScoreAdd) { $argList += @('--score-add', "$ScoreAdd") }
if ($Prune) { $argList += @('--prune', "$Prune") }
if ($NoNavigate) { $argList += '--no-navigate' }
if ($NoPost) {
  # drop a --post that came in as a default, keeping only the bare capture
  $argList = @($script, '--capture', '--frames', "$Frames", '--notches', "$Notches")
  if ($Title) { $argList += @('--title', $Title) }
  if ($ScoreGrow) { $argList += @('--score-grow', "$ScoreGrow") }
  if ($Prune) { $argList += @('--prune', "$Prune") }
}

# RedirectStandardOutput writes the raw bytes, so node's UTF-8 Chinese stays
# intact (a PowerShell-native `>` would decode it with the console code page and
# turn the names into mojibake).
$started = Get-Date
$p = Start-Process -FilePath $NodePath -ArgumentList $argList `
  -WorkingDirectory $RepoPath -NoNewWindow -PassThru -Wait `
  -RedirectStandardOutput $log -RedirectStandardError $err
if (Test-Path $err) {
  if ((Get-Item $err).Length -gt 0) {
    Add-Content -Path $log -Value '' -Encoding UTF8
    Add-Content -Path $log -Value '--- stderr ---' -Encoding UTF8
    Get-Content $err -Encoding UTF8 | Add-Content -Path $log -Encoding UTF8
  }
  Remove-Item $err -Force -ErrorAction SilentlyContinue
}
$secs = [int]((Get-Date) - $started).TotalSeconds

# Pull the numbers out of the freshest send-report.json so runs.log is readable
# on its own (that is the one thing to tail for a 3-minute loop).
$summary = 'no-report'
try {
  $newest = Get-ChildItem (Join-Path $RepoPath 'data\rank-shots') -Directory -ErrorAction SilentlyContinue |
    Where-Object { Test-Path (Join-Path $_.FullName 'send-report.json') } |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if ($newest) {
    $r = Get-Content (Join-Path $newest.FullName 'send-report.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    $summary = "sent=$($r.sent) written=$($r.written) unchanged=$($r.unchanged) " +
      "notOnSite=$(@($r.notOnSite).Count) failed=$(@($r.failed).Count) +$($r.scoreOffset) round=$($r.round)"
    Add-Content -Path $log -Value "send-report: $summary" -Encoding UTF8
  }
} catch {
  $summary = "report-unreadable: $($_.Exception.Message)"
}

Note ("exit=$($p.ExitCode) ${secs}s $summary")
Write-Output "exit=$($p.ExitCode) ${secs}s $summary"
Write-Output "log: $log"
exit $p.ExitCode
