[CmdletBinding()]
param(
  [switch]$NoBuild,
  [switch]$NoWatcher,
  [switch]$UseHelper,
  [string]$RelayConfigPath = '',
  [string]$BridgeUrl = '',
  [string]$BridgeToken = '',
  [int]$WaitSeconds = 90
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

function Read-ArkConst {
  param(
    [string]$Path,
    [string]$Name
  )
  if (-not (Test-Path -LiteralPath $Path)) {
    return ''
  }
  $text = Get-Content -LiteralPath $Path -Raw
  $pattern = "export\s+const\s+$([Regex]::Escape($Name)):\s*string\s*=\s*'([^']*)'"
  $match = [Regex]::Match($text, $pattern)
  if ($match.Success) {
    return $match.Groups[1].Value
  }
  return ''
}

function Read-ConfigValue {
  param(
    [hashtable]$Config,
    [string]$Name,
    [object]$DefaultValue
  )
  if ($Config.ContainsKey($Name) -and $null -ne $Config[$Name] -and -not [string]::IsNullOrWhiteSpace([string]$Config[$Name])) {
    return $Config[$Name]
  }
  return $DefaultValue
}

function Test-WatcherRunning {
  param([string]$ScriptPath)
  $name = 'powershell.exe'
  $processes = @(Get-CimInstance Win32_Process -Filter "Name = '$name'" -ErrorAction SilentlyContinue)
  foreach ($process in $processes) {
    $commandLine = [string]$process.CommandLine
    if (
      $commandLine.IndexOf($ScriptPath, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 -and
      $commandLine.IndexOf('-Watch', [System.StringComparison]::OrdinalIgnoreCase) -ge 0
    ) {
      return $true
    }
  }
  return $false
}

function Start-RelayWatcher {
  param(
    [string]$RepoRoot,
    [string]$ScriptPath,
    [string]$ConfigPath
  )
  if (Test-WatcherRunning -ScriptPath $ScriptPath) {
    Write-Info "本地 HDC Relay watchdog 已在运行"
    return
  }
  $logDir = Join-Path $RepoRoot 'logs\hdc-relay'
  New-Item -ItemType Directory -Force -Path $logDir | Out-Null
  Start-Process -FilePath 'powershell.exe' `
    -ArgumentList @('-ExecutionPolicy', 'Bypass', '-File', $ScriptPath, '-ConfigPath', $ConfigPath, '-Watch', '-WatchSeconds', '10') `
    -WorkingDirectory $RepoRoot `
    -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $logDir 'relay-hdc-watch.stdout.log') `
    -RedirectStandardError (Join-Path $logDir 'relay-hdc-watch.stderr.log') | Out-Null
  Write-Info "已启动本地 HDC Relay watchdog"
}

function Wait-HdcTarget {
  param(
    [string]$HdcPath,
    [string]$Target,
    [int]$Seconds
  )
  $deadline = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $deadline) {
    $targets = @(& $HdcPath list targets 2>&1)
    if ((($targets -join "`n") -match [Regex]::Escape($Target))) {
      $probe = @(& $HdcPath -t $Target shell 'echo remote-update-ok' 2>&1)
      if ($LASTEXITCODE -eq 0 -and (($probe -join "`n") -match 'remote-update-ok')) {
        return
      }
    }
    Start-Sleep -Seconds 2
  }
  throw "等待远程 HDC 目标超时: $Target"
}

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $scriptRoot '..\..'))
if ([string]::IsNullOrWhiteSpace($RelayConfigPath)) {
  $RelayConfigPath = Join-Path $scriptRoot 'hdc-relay.local.psd1'
}
if (-not (Test-Path -LiteralPath $RelayConfigPath)) {
  throw "缺少 Relay 配置: $RelayConfigPath"
}

$relayConfig = Import-PowerShellDataFile -LiteralPath $RelayConfigPath
$proxyHost = [string](Read-ConfigValue -Config $relayConfig -Name 'ProxyHost' -DefaultValue '127.0.0.1')
$proxyPort = [int](Read-ConfigValue -Config $relayConfig -Name 'ProxyPort' -DefaultValue 11078)
$hdcPath = [string](Read-ConfigValue -Config $relayConfig -Name 'HdcPath' -DefaultValue 'C:\openHarmony\20\toolchains\hdc.exe')
$target = "${proxyHost}:$proxyPort"
if (-not (Test-Path -LiteralPath $hdcPath)) {
  throw "HDC 不存在: $hdcPath"
}

$bridgeConfigPath = Join-Path $repoRoot 'HarmonyCodexRemote\entry\src\main\ets\config\BridgeConfig.ets'
if ([string]::IsNullOrWhiteSpace($BridgeUrl)) {
  $BridgeUrl = Read-ArkConst -Path $bridgeConfigPath -Name 'DEFAULT_BRIDGE_URL'
}
if ([string]::IsNullOrWhiteSpace($BridgeToken)) {
  $BridgeToken = Read-ArkConst -Path $bridgeConfigPath -Name 'DEFAULT_BRIDGE_TOKEN'
}

Write-Step "确保远程 HDC 链路在线"
if (-not $NoWatcher) {
  Start-RelayWatcher -RepoRoot $repoRoot -ScriptPath (Join-Path $scriptRoot 'connect-relay-hdc.ps1') -ConfigPath $RelayConfigPath
}
Wait-HdcTarget -HdcPath $hdcPath -Target $target -Seconds $WaitSeconds
Write-Info "远程 HDC 已在线: $target"

if ($UseHelper) {
  Write-Step "通过 Helper 承载的 HDC 更新并启动主应用"
} else {
  Write-Step "通过主 App 内置 HDC 更新"
  Write-Info "单 App 模式：安装主 App 后系统会停止旧进程，HDC 可能断开；请在手机上手动打开主 App 完成接续。"
}
$deployArgs = @(
  '-ExecutionPolicy', 'Bypass',
  '-File', (Join-Path $scriptRoot 'deploy.ps1'),
  '-DeviceId', $target
)
if ($UseHelper) {
  $deployArgs += '-RelayHostedByHelper'
}
if (-not $NoBuild) {
  $deployArgs += '-Build'
}
if (-not [string]::IsNullOrWhiteSpace($BridgeUrl)) {
  $deployArgs += @('-BridgeUrl', $BridgeUrl)
}
if (-not [string]::IsNullOrWhiteSpace($BridgeToken)) {
  $deployArgs += @('-BridgeToken', $BridgeToken)
}
& powershell @deployArgs
if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}

Write-Step "完成"
if ($UseHelper) {
  Write-Host "主应用已通过 Helper HDC 链路远程更新，并已尝试自动启动。" -ForegroundColor Green
} else {
  Write-Host "主应用已通过内置 HDC 链路远程更新。请在手机上手动打开主 App，应用会自动恢复公网 bridge 与 HDC 中继。" -ForegroundColor Green
}
