[CmdletBinding()]
param(
  [string]$TaskName = 'CodexRemoteBidirectionalLinkWatchdog',
  [switch]$RunNow
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$scriptPath = Join-Path $repoRoot 'scripts\remote-access\start-bidirectional-link-watchdog.ps1'
if (-not (Test-Path -LiteralPath $scriptPath)) {
  throw "Missing watchdog script: $scriptPath"
}

$logDir = Join-Path $repoRoot 'logs\remote-access'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

$powershell = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
$argument = "-NoProfile -ExecutionPolicy Bypass -File `"$scriptPath`""

$action = New-ScheduledTaskAction -Execute $powershell -Argument $argument -WorkingDirectory $repoRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Days 30) `
  -RestartCount 999 `
  -RestartInterval (New-TimeSpan -Minutes 1)
$userId = if ([string]::IsNullOrWhiteSpace($env:USERDOMAIN)) { $env:USERNAME } else { "$env:USERDOMAIN\$env:USERNAME" }
$principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited

try {
  Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Principal $principal `
    -Force | Out-Null

  if ($RunNow) {
    Start-ScheduledTask -TaskName $TaskName
  }

  Write-Host "Windows bidirectional watchdog task installed: $TaskName" -ForegroundColor Green
  if ($RunNow) {
    Write-Host "Task started." -ForegroundColor Green
  }
} catch {
  Write-Host "Scheduled task install failed: $($_.Exception.Message)" -ForegroundColor Yellow
  Write-Host "Falling back to current-user Startup shortcut." -ForegroundColor Yellow

  $startupDir = [Environment]::GetFolderPath('Startup')
  if ([string]::IsNullOrWhiteSpace($startupDir)) {
    throw 'Cannot resolve current-user Startup folder.'
  }
  $shortcutPath = Join-Path $startupDir "$TaskName.lnk"
  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($shortcutPath)
  $shortcut.TargetPath = $powershell
  $shortcut.Arguments = $argument
  $shortcut.WorkingDirectory = $repoRoot
  $shortcut.WindowStyle = 7
  $shortcut.Description = 'Keeps Codex remote Windows/Mac SSH and RDP tunnels alive.'
  $shortcut.Save()

  if ($RunNow) {
    Start-Process -WindowStyle Hidden -FilePath $powershell -ArgumentList @(
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-File', $scriptPath
    ) -WorkingDirectory $repoRoot | Out-Null
  }

  Write-Host "Windows bidirectional watchdog Startup shortcut installed: $shortcutPath" -ForegroundColor Green
  if ($RunNow) {
    Write-Host "Watchdog started in background." -ForegroundColor Green
  }
}
