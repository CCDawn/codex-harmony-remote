[CmdletBinding()]
param(
  [string]$BridgeUrl = 'http://127.0.0.1:8787',
  [string]$BridgeToken = $env:CODEX_BRIDGE_TOKEN,
  [string]$DeviceId = '',
  [string]$ConfigPath = '',
  [int]$BackgroundSeconds = 150,
  [int]$LockSeconds = 120
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Write-Step {
  param([string]$Message)
  Write-Host ""
  Write-Host "==> $Message" -ForegroundColor Cyan
}

function Invoke-Hdc {
  param(
    [string]$HdcExe,
    [string[]]$HdcArgs,
    [int]$TimeoutSeconds = 30
  )
  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = $HdcExe
  $startInfo.Arguments = ($HdcArgs | ForEach-Object {
    $value = [string]$_
    if ($value -match '\s|"') {
      '"' + $value.Replace('"', '\"') + '"'
    } else {
      $value
    }
  }) -join ' '
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  $startInfo.UseShellExecute = $false
  $process = [System.Diagnostics.Process]::Start($startInfo)
  if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
    $process.Kill()
    throw "hdc timeout: $($HdcArgs -join ' ')"
  }
  return (@($process.StandardOutput.ReadToEnd(), $process.StandardError.ReadToEnd()) -join "`n").Trim()
}

function Get-JsonlEntries {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) {
    return @()
  }
  return @(Get-Content -LiteralPath $Path | ForEach-Object {
    try {
      $_ | ConvertFrom-Json
    } catch {
      $null
    }
  } | Where-Object { $null -ne $_ })
}

function Count-BridgeAppRequests {
  param(
    [object[]]$Entries,
    [datetime]$From,
    [datetime]$To
  )
  return @($Entries | Where-Object {
    $timestamp = ([datetime]$_.timestamp).ToUniversalTime()
    $timestamp -ge $From -and $timestamp -le $To -and $_.event -eq 'http.request.completed' -and (
      [string]$_.data.url -like '/projects*' -or
      [string]$_.data.url -like '/tasks*' -or
      [string]$_.data.url -like '/api/codex/threads*' -or
      [string]$_.data.url -eq '/logs'
    )
  }).Count
}

function Count-AppLogs {
  param(
    [object[]]$Entries,
    [datetime]$From,
    [datetime]$To
  )
  return @($Entries | Where-Object {
    $timestamp = ([datetime]$_.timestamp).ToUniversalTime()
    $timestamp -ge $From -and $timestamp -le $To
  }).Count
}

function Write-PhaseResult {
  param(
    [string]$Name,
    [int]$BridgeRequests,
    [int]$AppLogs,
    [bool]$Pass
  )
  $status = if ($Pass) { 'PASS' } else { 'PAUSED' }
  $color = if ($Pass) { 'Green' } else { 'Yellow' }
  Write-Host ("{0}: {1} bridgeRequests={2} appLogs={3}" -f $Name, $status, $BridgeRequests, $AppLogs) -ForegroundColor $color
}

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $scriptRoot '..\..'))
if ([string]::IsNullOrWhiteSpace($ConfigPath)) {
  $ConfigPath = Join-Path $scriptRoot 'codex-remote.config.psd1'
}
$config = Import-PowerShellDataFile -LiteralPath $ConfigPath
$hdcExe = if ($config.HdcPath) { [string]$config.HdcPath } else { 'C:\openHarmony\20\toolchains\hdc.exe' }
$bundleName = [string]$config.BundleName
$abilityName = [string]$config.AbilityName

if (-not (Test-Path -LiteralPath $hdcExe)) {
  throw "HDC not found: $hdcExe"
}

$headers = @{}
if (-not [string]::IsNullOrWhiteSpace($BridgeToken)) {
  $headers['X-Codex-Bridge-Token'] = $BridgeToken
}

Write-Step "Start clean log run"
$runBody = @{ label = 'background-lock-smoke' } | ConvertTo-Json
$run = Invoke-RestMethod -Method Post -Uri "$BridgeUrl/logs/run" -Body $runBody -ContentType 'application/json' -Headers $headers -TimeoutSec 15
Write-Host "run=$($run.run.runId)"

Write-Step "Resolve HDC device"
if ([string]::IsNullOrWhiteSpace($DeviceId)) {
  $targets = @(& $hdcExe list targets 2>&1 | Where-Object { $_ -and $_ -notmatch 'Empty' } | ForEach-Object { ($_ -split '\s+')[0] })
  if ($targets.Count -eq 0) {
    throw "No online HDC device"
  }
  $DeviceId = $targets[0]
}
$probe = Invoke-Hdc -HdcExe $hdcExe -HdcArgs @('-t', $DeviceId, 'shell', 'echo', 'codex-background-smoke') -TimeoutSeconds 20
if ($probe -notmatch 'codex-background-smoke') {
  throw "HDC probe failed: $probe"
}
Write-Host "device=$DeviceId"

Write-Step "Launch app baseline"
$baselineStart = (Get-Date).ToUniversalTime()
Invoke-Hdc -HdcExe $hdcExe -HdcArgs @('-t', $DeviceId, 'shell', 'aa', 'start', '-a', $abilityName, '-b', $bundleName) -TimeoutSeconds 30 | Out-Host
Start-Sleep -Seconds 15
$baselineEnd = (Get-Date).ToUniversalTime()

Write-Step "Move app to background"
$backgroundStart = (Get-Date).ToUniversalTime()
Invoke-Hdc -HdcExe $hdcExe -HdcArgs @('-t', $DeviceId, 'shell', 'uitest', 'uiInput', 'keyEvent', 'Home') -TimeoutSeconds 20 | Out-Host
Start-Sleep -Seconds $BackgroundSeconds
$backgroundEnd = (Get-Date).ToUniversalTime()

Write-Step "Lock screen"
Invoke-Hdc -HdcExe $hdcExe -HdcArgs @('-t', $DeviceId, 'shell', 'aa', 'start', '-a', $abilityName, '-b', $bundleName) -TimeoutSeconds 30 | Out-Host
Start-Sleep -Seconds 10
$lockStart = (Get-Date).ToUniversalTime()
Invoke-Hdc -HdcExe $hdcExe -HdcArgs @('-t', $DeviceId, 'shell', 'power-shell', 'suspend') -TimeoutSeconds 20 | Out-Host
Start-Sleep -Seconds $LockSeconds
$lockEnd = (Get-Date).ToUniversalTime()
Invoke-Hdc -HdcExe $hdcExe -HdcArgs @('-t', $DeviceId, 'shell', 'power-shell', 'wakeup') -TimeoutSeconds 20 | Out-Host
Start-Sleep -Seconds 15

$bridgeEntries = Get-JsonlEntries -Path (Join-Path $repoRoot 'logs\current-run\bridge.jsonl')
$appEntries = Get-JsonlEntries -Path (Join-Path $repoRoot 'logs\current-run\harmony-app.jsonl')

$baselineBridge = Count-BridgeAppRequests -Entries $bridgeEntries -From $baselineStart -To $baselineEnd
$baselineApp = Count-AppLogs -Entries $appEntries -From $baselineStart -To $baselineEnd
$backgroundBridge = Count-BridgeAppRequests -Entries $bridgeEntries -From $backgroundStart.AddSeconds(10) -To $backgroundEnd
$backgroundApp = Count-AppLogs -Entries $appEntries -From $backgroundStart.AddSeconds(10) -To $backgroundEnd
$lockBridge = Count-BridgeAppRequests -Entries $bridgeEntries -From $lockStart.AddSeconds(10) -To $lockEnd
$lockApp = Count-AppLogs -Entries $appEntries -From $lockStart.AddSeconds(10) -To $lockEnd

Write-Step "Results"
Write-PhaseResult -Name 'baseline.foreground' -BridgeRequests $baselineBridge -AppLogs $baselineApp -Pass ($baselineBridge -gt 0)
Write-PhaseResult -Name 'background.after_grace' -BridgeRequests $backgroundBridge -AppLogs $backgroundApp -Pass ($backgroundBridge -gt 0 -or $backgroundApp -gt 0)
Write-PhaseResult -Name 'lockscreen.after_grace' -BridgeRequests $lockBridge -AppLogs $lockApp -Pass ($lockBridge -gt 0 -or $lockApp -gt 0)
Write-Host "Windows:"
Write-Host "  baseline:   $($baselineStart.ToString('o')) -> $($baselineEnd.ToString('o'))"
Write-Host "  background: $($backgroundStart.ToString('o')) -> $($backgroundEnd.ToString('o'))"
Write-Host "  lockscreen: $($lockStart.ToString('o')) -> $($lockEnd.ToString('o'))"
