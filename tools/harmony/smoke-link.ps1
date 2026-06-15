[CmdletBinding()]
param(
  [string]$BridgeUrl = 'http://127.0.0.1:8787',
  [string]$BridgeToken = $env:CODEX_BRIDGE_TOKEN,
  [string]$DeviceId = '',
  [string]$ConfigPath = '',
  [int]$TimeoutSeconds = 35,
  [int]$RecentLogSeconds = 180,
  [switch]$SkipLaunch,
  [switch]$SkipAppLog
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Write-Step {
  param([string]$Message)
  Write-Host ""
  Write-Host "==> $Message" -ForegroundColor Cyan
}

function Write-Info {
  param([string]$Message)
  Write-Host "    $Message" -ForegroundColor DarkGray
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
    throw "hdc 超时: $($HdcArgs -join ' ')"
  }
  return @{
    ExitCode = $process.ExitCode
    Output = (@($process.StandardOutput.ReadToEnd(), $process.StandardError.ReadToEnd()) -join "`n")
  }
}

function Test-HdcOutputFailed {
  param([string]$Output)
  return $Output -match '(?i)(\[Fail\]|failed|failure|error|exception|E\d{6})'
}

function Get-OnlineTargets {
  param([string]$HdcExe)
  $raw = & $HdcExe list targets 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw "hdc list targets 失败: $raw"
  }
  return @($raw | Where-Object { $_ -and $_ -notmatch 'Empty' } | ForEach-Object { ($_ -split '\s+')[0] })
}

function Test-IsRelayHdcDevice {
  param([string]$DeviceId)

  return $DeviceId -match '^(127\.0\.0\.1|localhost|\[::1\]|::1):\d+$'
}

function Get-RelayHdcTargetFromConfig {
  param([string]$ScriptRoot)

  $relayConfigPath = Join-Path $ScriptRoot 'hdc-relay.local.psd1'
  if (-not (Test-Path -LiteralPath $relayConfigPath)) {
    return ''
  }
  $relayConfig = Import-PowerShellDataFile -LiteralPath $relayConfigPath
  $proxyHost = if ($relayConfig.ProxyHost) { [string]$relayConfig.ProxyHost } else { '127.0.0.1' }
  $proxyPort = if ($relayConfig.ProxyPort) { [int]$relayConfig.ProxyPort } else { 11078 }
  return "${proxyHost}:$proxyPort"
}

function Test-LocalProxyListening {
  param([string]$DeviceId)

  if (-not (Test-IsRelayHdcDevice -DeviceId $DeviceId)) {
    return $false
  }
  $portText = ($DeviceId -replace '^.*:', '')
  if ($portText -notmatch '^\d+$') {
    return $false
  }
  $port = [int]$portText
  try {
    return @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue).Count -gt 0
  } catch {
    return $false
  }
}

function Start-LocalProxyIfNeeded {
  param(
    [string]$ScriptRoot,
    [string]$RepoRoot,
    [string]$DeviceId
  )

  if (-not (Test-IsRelayHdcDevice -DeviceId $DeviceId)) {
    return
  }
  if (Test-LocalProxyListening -DeviceId $DeviceId) {
    return
  }

  $relayConfigPath = Join-Path $ScriptRoot 'hdc-relay.local.psd1'
  $relayScript = Join-Path $ScriptRoot 'start-hdc-relay.ps1'
  if (-not (Test-Path -LiteralPath $relayConfigPath) -or -not (Test-Path -LiteralPath $relayScript)) {
    Write-Info "无线 HDC 本地代理未监听，但缺少自动启动配置。"
    return
  }

  $logRoot = Join-Path $RepoRoot 'logs\startup'
  New-Item -ItemType Directory -Force -Path $logRoot | Out-Null
  Write-Info "无线 HDC 本地代理未监听，尝试启动: $DeviceId"
  Start-Process -FilePath 'powershell.exe' -ArgumentList @(
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-File', $relayScript,
      '-Mode', 'Proxy',
      '-ConfigPath', $relayConfigPath
    ) -WorkingDirectory $RepoRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logRoot 'hdc-proxy-smoke.stdout.log') -RedirectStandardError (Join-Path $logRoot 'hdc-proxy-smoke.stderr.log') | Out-Null

  for ($i = 0; $i -lt 24; $i++) {
    Start-Sleep -Milliseconds 500
    if (Test-LocalProxyListening -DeviceId $DeviceId) {
      Write-Info "无线 HDC 本地代理已监听: $DeviceId"
      return
    }
  }
}

function Ensure-HdcTargetOnline {
  param(
    [string]$HdcExe,
    [string]$DeviceId,
    [string]$ScriptRoot,
    [string]$RepoRoot
  )

  if ([string]::IsNullOrWhiteSpace($DeviceId)) {
    return
  }
  if (-not (Test-IsRelayHdcDevice -DeviceId $DeviceId)) {
    return
  }

  Start-LocalProxyIfNeeded -ScriptRoot $ScriptRoot -RepoRoot $RepoRoot -DeviceId $DeviceId
  $verboseTargets = @(& $HdcExe list targets -v 2>&1)
  if (($verboseTargets -join "`n") -match ([Regex]::Escape($DeviceId) + '.*\bOffline\b')) {
    Write-Info "无线 HDC 目标处于 Offline，重启 hdc server 后重连。"
    & $HdcExe kill -r 2>&1 | Out-Null
    Start-Sleep -Seconds 1
  }

  for ($i = 0; $i -lt 8; $i++) {
    $tconn = @(& $HdcExe tconn $DeviceId 2>&1)
    if (($tconn -join "`n") -match 'Connect OK|Target is connected') {
      return
    }
    Start-Sleep -Seconds 2
  }
}

function Wait-AppLogAfter {
  param(
    [string]$RepoRoot,
    [datetime]$After,
    [int]$TimeoutSeconds,
    [int]$RecentLogSeconds
  )
  $logPath = Join-Path $RepoRoot 'logs\current-run\harmony-app.jsonl'
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  $latestRecentEntry = $null
  while ((Get-Date) -lt $deadline) {
    if (Test-Path -LiteralPath $logPath) {
      $lines = @(Get-Content -LiteralPath $logPath -Tail 120 -ErrorAction SilentlyContinue)
      foreach ($line in $lines) {
        try {
          $entry = $line | ConvertFrom-Json
          $timestamp = [datetime]$entry.timestamp
          if ($timestamp.ToUniversalTime() -ge (Get-Date).ToUniversalTime().AddSeconds(-1 * $RecentLogSeconds)) {
            $latestRecentEntry = $entry
          }
          if ($timestamp.ToUniversalTime() -ge $After.ToUniversalTime()) {
            return $entry
          }
        } catch {
        }
      }
    }
    Start-Sleep -Seconds 2
  }
  if ($null -ne $latestRecentEntry) {
    return $latestRecentEntry
  }
  throw "等待手机 App 日志超时。App 可能未启动，或无法上传日志到 bridge。"
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
  throw "HDC 不存在: $hdcExe"
}

Write-Step "检查 bridge 健康"
$headers = @{}
if (-not [string]::IsNullOrWhiteSpace($BridgeToken)) {
  $headers['X-Codex-Bridge-Token'] = $BridgeToken
}
$health = Invoke-RestMethod -Uri "$BridgeUrl/health" -Headers $headers -TimeoutSec 8
Write-Info "bridge ok: run=$($health.run.runId)"
$threads = Invoke-RestMethod -Uri "$BridgeUrl/api/codex/threads?limit=3" -Headers $headers -TimeoutSec 12
Write-Info "codex sessions ok: $(@($threads.threads).Count) threads"

Write-Step "检查 HDC 设备"
$relayTarget = Get-RelayHdcTargetFromConfig -ScriptRoot $scriptRoot
if ([string]::IsNullOrWhiteSpace($DeviceId) -and -not [string]::IsNullOrWhiteSpace($relayTarget)) {
  $DeviceId = $relayTarget
}
Ensure-HdcTargetOnline -HdcExe $hdcExe -DeviceId $DeviceId -ScriptRoot $scriptRoot -RepoRoot $repoRoot
$targets = @(Get-OnlineTargets -HdcExe $hdcExe)
if ($targets.Count -eq 0) {
  throw "没有在线 HDC 设备"
}
if ([string]::IsNullOrWhiteSpace($DeviceId)) {
  $DeviceId = $targets[0]
}
if (($targets -join "`n") -notmatch [Regex]::Escape($DeviceId)) {
  throw "目标设备不在线: $DeviceId; online=$($targets -join ', ')"
}
$probe = Invoke-Hdc -HdcExe $hdcExe -HdcArgs @('-t', $DeviceId, 'shell', 'echo', 'codex-link-ok') -TimeoutSeconds 20
if ($probe.ExitCode -ne 0 -or (Test-HdcOutputFailed -Output $probe.Output) -or $probe.Output -notmatch 'codex-link-ok') {
  throw "HDC shell 探测失败: $($probe.Output)"
}
Write-Info "hdc ok: $DeviceId"

if (-not $SkipLaunch) {
  Write-Step "启动手机 App"
  $startedAt = (Get-Date).ToUniversalTime().AddSeconds(-2)
  $start = Invoke-Hdc -HdcExe $hdcExe -HdcArgs @('-t', $DeviceId, 'shell', 'aa', 'start', '-a', $abilityName, '-b', $bundleName) -TimeoutSeconds 30
  if ($start.ExitCode -ne 0 -or (Test-HdcOutputFailed -Output $start.Output)) {
    throw "启动 App 失败: $($start.Output)"
  }
  Write-Info "aa start ok"
  if (-not $SkipAppLog) {
    $entry = Wait-AppLogAfter -RepoRoot $repoRoot -After $startedAt -TimeoutSeconds $TimeoutSeconds -RecentLogSeconds $RecentLogSeconds
    Write-Info "app log ok: $($entry.event) @ $($entry.timestamp)"
  }
}

Write-Step "链路冒烟通过"
Write-Host "bridge / codex sessions / hdc / app log 均正常。" -ForegroundColor Green
