# Register (or remove) the Windows scheduled task that runs the leaderboard
# grabber: either once a day, or every N minutes (the trial loop).
#
#   .\scripts\install-rank-task.ps1 -At 22:00                 # daily at 22:00
#   .\scripts\install-rank-task.ps1 -EveryMinutes 3 -ScoreGrow 100 -Prune 6
#   .\scripts\install-rank-task.ps1 -EveryMinutes 3 -RunNow   # register + fire once
#   .\scripts\install-rank-task.ps1 -WeeklyDay Thursday -Windows '12:15-13:30,20:15-21:00' -EveryMinutes 15 -Prune 20
#       Thursdays only, every 15 minutes inside those two windows (6 + 4 fires a day)
#   .\scripts\install-rank-task.ps1 -Remove
#
# Three things this gets right that a plain `schtasks /create` does not:
#
#  1. -RunLevel Highest. The game runs elevated (com.bilibili.nslg), and Windows
#     UIPI silently drops synthetic input aimed at a higher integrity level: the
#     window focuses, the drag does nothing, no error. The task must be elevated
#     or the scrolling never happens.
#
#  2. Interactive logon only. The capture is a screen grab, so it needs the user's
#     desktop: a task running "whether or not the user is logged on" lands in a
#     session with no visible screen and captures black frames.
#
#  3. It fires scripts\run-rank-shot.ps1, not node. A task has no console, so the
#     wrapper is what leaves data\rank-shots\logs\runs.log behind. Without it a
#     failed run dies silently.
#
# The repetition duration is deliberately omitted when registering the interval
# trigger: "PT0S"/MaxValue is rejected by the Task Scheduler XML validator
# ("value ... incorrectly formatted or out of range"), while a trigger with no
# duration at all means "repeat forever".
#
# -Windows mode is different: it hangs a *bounded* repetition onto a weekly
# trigger (one trigger per window). Two things there are not obvious:
#   * Repetition.StopAtDurationEnd defaults to True, which **kills a run that is
#     still going when the window closes** -- a 13:30 fire would be terminated at
#     13:31 mid-capture. It is set to False here.
#   * The duration is (window length + 1 minute), so the closing minute is itself
#     one of the fires (12:15..13:30 = 6 fires, not 5).
#
# ASCII only: Windows PowerShell 5.1 reads .ps1 as ANSI.
param(
  [string]$TaskName = 'yanwu-rank-shot',
  [string]$At = '22:00',
  # > 0 = repeat every N minutes instead of the daily -At fire. In -Windows mode
  # this is the repeat interval *inside* each window (default 15).
  [int]$EveryMinutes = 0,
  # Weekly windows mode: -WeeklyDay Thursday -Windows '12:15-13:30,20:15-21:00'
  [ValidateSet('Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday')]
  [string]$WeeklyDay = '',
  [string]$Windows = '',
  [string]$RepoPath = '',
  [string]$NodePath = '',
  [string]$Post = '',
  [string]$Token = '',
  [int]$Frames = 18,
  [int]$Notches = 4,
  [string]$Title = '',
  # Trial knobs, forwarded to the wrapper: every real run adds another N on top
  # of the real score (see the comment on --score-grow in rank-shot.js).
  [int]$ScoreGrow = 0,
  [int]$ScoreAdd = 0,
  # Keep only the newest N capture dirs in data\rank-shots (0 = keep everything).
  [int]$Prune = 0,
  [string]$ProcessName = 'com.bilibili.nslg',
  # Highest is what makes the scrolling work at all (see header). Limited is only
  # for checking the plumbing on a machine where you cannot elevate right now --
  # a Limited task will run the tool but the input will be dropped by UIPI.
  [ValidateSet('Highest', 'Limited')][string]$RunLevel = 'Highest',
  [switch]$NoNavigate,
  [switch]$NoPost,
  [switch]$Remove,
  [switch]$RunNow
)

$ErrorActionPreference = 'Stop'

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$elevated = ([Security.Principal.WindowsPrincipal]$identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

# Registering a task whose principal is "Highest" needs an elevated shell; without
# one Windows answers 0x80070005 (Access is denied) from Register-ScheduledTask,
# which tells a user nothing. So say it in words, before doing anything.
if (-not $elevated -and $RunLevel -eq 'Highest' -and -not $Remove) {
  throw 'Registering a "Highest" task needs an elevated shell (Windows answers 0x80070005 otherwise). Right-click PowerShell > "Run as administrator", then run this script again. A Limited task can be registered here, but Windows drops the input it sends.'
}

if ($Remove) {
  $t = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if (-not $t) { Write-Output "no task named $TaskName"; exit 0 }
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Output "removed: $TaskName"
  exit 0
}

if (-not $RepoPath) { $RepoPath = Split-Path $PSScriptRoot -Parent }
$wrapper = Join-Path $RepoPath 'scripts\run-rank-shot.ps1'
if (-not (Test-Path $wrapper)) { throw "run-rank-shot.ps1 not found under $RepoPath" }

# node: explicit > tools\node.exe in the repo > PATH.
if (-not $NodePath) {
  $local = Join-Path $RepoPath 'tools\node.exe'
  if (Test-Path $local) { $NodePath = $local }
}
if (-not $NodePath) {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { $NodePath = $cmd.Source }
}
if (-not $NodePath -or -not (Test-Path $NodePath)) {
  throw 'node.exe not found. Put one at tools\node.exe or pass -NodePath "C:\Program Files\nodejs\node.exe"'
}

$ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'

# The command line the task will run. Quote anything with a space in it.
# No --out anywhere: the tool defaults to data/rank-shots/<timestamp>, and a task
# has no shell to expand $(...) in, so a fixed literal path would overwrite itself.
$argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
  '-File', $wrapper, '-RepoPath', $RepoPath, '-NodePath', $NodePath,
  '-Frames', $Frames, '-Notches', $Notches, '-ProcessName', $ProcessName)
if ($Title) { $argList += @('-Title', $Title) }
if ($Post) { $argList += @('-Post', $Post) }
if ($Token) { $argList += @('-Token', $Token) }
if ($ScoreGrow) { $argList += @('-ScoreGrow', $ScoreGrow) }
if ($ScoreAdd) { $argList += @('-ScoreAdd', $ScoreAdd) }
if ($Prune) { $argList += @('-Prune', $Prune) }
if ($NoNavigate) { $argList += '-NoNavigate' }
if ($NoPost) { $argList += '-NoPost' }
$argLine = ($argList | ForEach-Object {
    $s = [string]$_
    if ($s -match '\s') { '"' + $s + '"' } else { $s }
  }) -join ' '

$action = New-ScheduledTaskAction -Execute $ps -Argument $argLine -WorkingDirectory $RepoPath

$triggers = @()
$schedule = ''
$notes = @()

if ($Windows) {
  if (-not $WeeklyDay) { throw '-Windows needs -WeeklyDay, e.g. -WeeklyDay Thursday.' }
  $step = if ($EveryMinutes -gt 0) { $EveryMinutes } else { 15 }
  foreach ($raw in ($Windows -split ',')) {
    $w = $raw.Trim()
    if ($w -notmatch '^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$') {
      throw "window '$w' is not HH:mm-HH:mm"
    }
    $h1 = [int]$Matches[1]; $m1 = [int]$Matches[2]; $h2 = [int]$Matches[3]; $m2 = [int]$Matches[4]
    $span = ($h2 * 60 + $m2) - ($h1 * 60 + $m1)
    if ($span -le 0) { throw "window '$w' ends before it starts" }
    $start = '{0:00}:{1:00}' -f $h1, $m1
    $end = '{0:00}:{1:00}' -f $h2, $m2
    $fires = [int][math]::Floor($span / $step) + 1

    $t = New-ScheduledTaskTrigger -Weekly -DaysOfWeek $WeeklyDay -At $start
    $rep = (New-ScheduledTaskTrigger -Once -At $start `
        -RepetitionInterval (New-TimeSpan -Minutes $step) `
        -RepetitionDuration (New-TimeSpan -Minutes ($span + 1))).Repetition
    # See the header: True would kill a run that is still going when the window
    # closes (13:30 fire terminated at 13:31, mid-capture).
    $rep.StopAtDurationEnd = $false
    $t.Repetition = $rep
    $triggers += $t
    $notes += "window : $start-$end  every $step min -> $fires fires"
  }
  $schedule = "every $WeeklyDay, inside $Windows"
} elseif ($EveryMinutes -gt 0) {
  # No -RepetitionDuration: that is how "repeat indefinitely" is expressed, and
  # MaxValue is rejected by the XML validator (see header).
  $triggers = @(New-ScheduledTaskTrigger -Once -At ((Get-Date).AddMinutes(1)) `
      -RepetitionInterval (New-TimeSpan -Minutes $EveryMinutes))
  $schedule = "every $EveryMinutes minutes (indefinitely)"
} else {
  $triggers = @(New-ScheduledTaskTrigger -Daily -At $At)
  $schedule = "daily at $At"
}

$principal = New-ScheduledTaskPrincipal `
  -UserId $identity.Name `
  -LogonType Interactive -RunLevel $RunLevel
# IgnoreNew matters for the interval trigger: one capture takes ~3 minutes, so a
# 3-minute cadence means the next tick can arrive while the previous one is still
# scrolling. IgnoreNew skips that tick instead of stacking two grabs on top of
# each other (two processes clicking and dragging the same window = garbage).
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 20)

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $triggers `
  -Principal $principal -Settings $settings -Description 'Yanwu rank leaderboard: scroll, OCR, POST name+score' -Force | Out-Null

Write-Output "registered: $TaskName  $schedule"
foreach ($n in $notes) { Write-Output "  $n" }
Write-Output "  run as : $($identity.Name) ($RunLevel, only when logged on)"
Write-Output "  command: `"$ps`" $argLine"
Write-Output "  cwd    : $RepoPath"
if ($ScoreGrow) { Write-Output "  trial  : every real run adds +$ScoreGrow on top of the real score (cumulative)" }
if ($Prune) { Write-Output "  disk   : keeps the newest $Prune capture dirs under data\rank-shots" }
Write-Output ''
Write-Output 'Reminders:'
Write-Output '  * the game must be running; leave it on the hall or the ranking screen and the tool'
Write-Output '    backs out and re-enters the ranking by itself to force a data refresh'
Write-Output '  * it takes focus for the whole capture (two clicks + the scrolling), then gives it back'
Write-Output '  * each run logs:  data\rank-shots\logs\run-<stamp>.log'
Write-Output '  * summary lines : data\rank-shots\logs\runs.log     (tail this one)'
Write-Output "  * test now : Start-ScheduledTask -TaskName $TaskName"
Write-Output "  * stop it  : Stop-ScheduledTask -TaskName $TaskName ; Unregister-ScheduledTask -TaskName $TaskName -Confirm:`$false"
Write-Output "  * results  : $RepoPath\data\rank-shots\"
Write-Output "  * remove   : .\scripts\install-rank-task.ps1 -Remove"

if ($RunNow) {
  Start-ScheduledTask -TaskName $TaskName
  Write-Output ''
  Write-Output 'started. follow it with:'
  Write-Output "  Get-ScheduledTaskInfo -TaskName $TaskName | Format-List"
}
