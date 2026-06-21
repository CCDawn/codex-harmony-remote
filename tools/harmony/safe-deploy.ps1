[CmdletBinding()]
param(
  [string]$DeviceId = '',
  [string]$BridgeUrl = $env:CODEX_BRIDGE_URL,
  [string]$BridgeToken = $env:CODEX_BRIDGE_TOKEN,
  [string]$ConfigPath = '',
  [switch]$NoBuild,
  [switch]$RelayHostedByHelper,
  [switch]$SkipTests,
  [switch]$SkipSmoke
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

function Resolve-LatestHap {
  param([string]$ProjectRoot)
  $haps = @(Get-ChildItem -Path (Join-Path $ProjectRoot 'entry\build') -Recurse -Filter *.hap -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match 'signed\.hap$|\.hap$' } |
    Sort-Object LastWriteTime -Descending)
  if ($haps.Count -eq 0) {
    throw "没有找到 HAP，请先构建。"
  }
  return $haps[0].FullName
}

function Copy-HapSnapshot {
  param(
    [string]$HapPath,
    [string]$SnapshotDir,
    [string]$Name
  )
  New-Item -ItemType Directory -Path $SnapshotDir -Force | Out-Null
  $target = Join-Path $SnapshotDir $Name
  Copy-Item -LiteralPath $HapPath -Destination $target -Force
  return $target
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
  $match = [regex]::Match($text, "export\s+const\s+$([regex]::Escape($Name))\s*:\s*string\s*=\s*'([^']*)'")
  if ($match.Success) {
    return $match.Groups[1].Value
  }
  return ''
}

function Invoke-SafeSmoke {
  param(
    [string]$ScriptRoot,
    [string]$BridgeUrl,
    [string]$BridgeToken,
    [string]$DeviceId,
    [string]$ConfigPath
  )
  $args = @(
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', (Join-Path $ScriptRoot 'smoke-link.ps1')
  )
  if (-not [string]::IsNullOrWhiteSpace($BridgeUrl)) {
    $args += @('-BridgeUrl', $BridgeUrl)
  }
  if (-not [string]::IsNullOrWhiteSpace($BridgeToken)) {
    $args += @('-BridgeToken', $BridgeToken)
  }
  if (-not [string]::IsNullOrWhiteSpace($ConfigPath)) {
    $args += @('-ConfigPath', $ConfigPath)
  }
  if (-not [string]::IsNullOrWhiteSpace($DeviceId)) {
    $args += @('-DeviceId', $DeviceId)
  }
  & powershell.exe @args
  if ($LASTEXITCODE -ne 0) {
    throw "链路冒烟失败，退出码: $LASTEXITCODE"
  }
}

function Invoke-Deploy {
  param(
    [string]$ScriptRoot,
    [string]$DeviceId,
    [string]$BridgeUrl,
    [string]$BridgeToken,
    [string]$ConfigPath,
    [string]$ProjectPath,
    [switch]$Build,
    [switch]$RelayHostedByHelper
  )
  $args = @(
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', (Join-Path $ScriptRoot 'deploy.ps1')
  )
  if (-not [string]::IsNullOrWhiteSpace($BridgeUrl)) {
    $args += @('-BridgeUrl', $BridgeUrl)
  }
  if (-not [string]::IsNullOrWhiteSpace($BridgeToken)) {
    $args += @('-BridgeToken', $BridgeToken)
  }
  if (-not [string]::IsNullOrWhiteSpace($ConfigPath)) {
    $args += @('-ConfigPath', $ConfigPath)
  }
  if (-not [string]::IsNullOrWhiteSpace($DeviceId)) {
    $args += @('-DeviceId', $DeviceId)
  }
  if (-not [string]::IsNullOrWhiteSpace($ProjectPath)) {
    $args += @('-ProjectPath', $ProjectPath)
  }
  if ($Build) {
    $args += '-Build'
  }
  if ($RelayHostedByHelper) {
    $args += '-RelayHostedByHelper'
  }
  & powershell.exe @args
  if ($LASTEXITCODE -ne 0) {
    throw "部署失败，退出码: $LASTEXITCODE"
  }
}

function Invoke-Rollback {
  param(
    [string]$ScriptRoot,
    [string]$RepoRoot,
    [hashtable]$Config,
    [string]$DeviceId,
    [string]$GoodHapPath,
    [switch]$RelayHostedByHelper
  )
  if (-not (Test-Path -LiteralPath $GoodHapPath)) {
    throw "没有可回滚 HAP: $GoodHapPath"
  }
  $rollbackConfig = Join-Path $RepoRoot 'logs\safe-deploy\rollback.config.psd1'
  New-Item -ItemType Directory -Path (Split-Path -Parent $rollbackConfig) -Force | Out-Null
  $content = @"
@{
  BundleName = '$($Config.BundleName)'
  AbilityName = '$($Config.AbilityName)'
  ProductName = '$($Config.ProductName)'
  ModuleName = '$($Config.ModuleName)'
  BuildTask = '$($Config.BuildTask)'
  HapPath = '$($GoodHapPath.Replace("'", "''"))'
  HdcPath = '$($Config.HdcPath)'
  AutoLaunch = `$true
  ForceStopBeforeLaunch = `$true
  Devices = @()
}
"@
  Set-Content -LiteralPath $rollbackConfig -Value $content -Encoding UTF8
  $args = @(
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', (Join-Path $ScriptRoot 'deploy.ps1'),
    '-ConfigPath', $rollbackConfig
  )
  if (-not [string]::IsNullOrWhiteSpace($DeviceId)) {
    $args += @('-DeviceId', $DeviceId)
  }
  if ($RelayHostedByHelper) {
    $args += '-RelayHostedByHelper'
  }
  & powershell.exe @args
  if ($LASTEXITCODE -ne 0) {
    throw "回滚安装失败，退出码: $LASTEXITCODE"
  }
}

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $scriptRoot '..\..'))
$projectRoot = Join-Path $repoRoot 'HarmonyCodexRemote'
if ([string]::IsNullOrWhiteSpace($ConfigPath)) {
  $ConfigPath = Join-Path $scriptRoot 'codex-remote.config.psd1'
}
$bridgeConfigPath = Join-Path $projectRoot 'entry\src\main\ets\config\BridgeConfig.ets'
if ([string]::IsNullOrWhiteSpace($BridgeUrl)) {
  $BridgeUrl = Read-ArkConst -Path $bridgeConfigPath -Name 'DEFAULT_BRIDGE_URL'
}
if ([string]::IsNullOrWhiteSpace($BridgeToken)) {
  $BridgeToken = Read-ArkConst -Path $bridgeConfigPath -Name 'DEFAULT_BRIDGE_TOKEN'
}
$config = Import-PowerShellDataFile -LiteralPath $ConfigPath
$snapshotDir = Join-Path $repoRoot 'artifacts\hap\known-good'
$lastGoodPath = Join-Path $snapshotDir 'last-known-good.hap'

Write-Step "安全部署前检查"
if ($BridgeUrl -match '^https?://(127\.0\.0\.1|localhost)(:\d+)?(/|$)' -and -not $RelayHostedByHelper) {
  throw "拒绝把手机端默认 Bridge 写成本机地址: $BridgeUrl。请使用公网地址，或明确使用 -RelayHostedByHelper。"
}
if (-not $SkipSmoke) {
  Invoke-SafeSmoke -ScriptRoot $scriptRoot -BridgeUrl $BridgeUrl -BridgeToken $BridgeToken -DeviceId $DeviceId -ConfigPath $ConfigPath
}
if (-not (Test-Path -LiteralPath $lastGoodPath)) {
  try {
    $currentHap = Resolve-LatestHap -ProjectRoot $projectRoot
    Copy-HapSnapshot -HapPath $currentHap -SnapshotDir $snapshotDir -Name 'last-known-good.hap' | Out-Null
    Write-Info "已建立初始回滚 HAP: $lastGoodPath"
  } catch {
    Write-Info "暂未建立初始回滚 HAP: $($_.Exception.Message)"
  }
}

if (-not $SkipTests) {
  Write-Step "运行 Node 回归测试"
  Push-Location $repoRoot
  try {
    npm test
    if ($LASTEXITCODE -ne 0) {
      throw "npm test 失败"
    }
  } finally {
    Pop-Location
  }
}

$deployed = $false
try {
  Write-Step "部署候选版本"
  Invoke-Deploy -ScriptRoot $scriptRoot -DeviceId $DeviceId -BridgeUrl $BridgeUrl -BridgeToken $BridgeToken -ConfigPath $ConfigPath -Build:(-not $NoBuild) -RelayHostedByHelper:$RelayHostedByHelper
  $deployed = $true

  if (-not $SkipSmoke) {
    Write-Step "部署后链路验证"
    Invoke-SafeSmoke -ScriptRoot $scriptRoot -BridgeUrl $BridgeUrl -BridgeToken $BridgeToken -DeviceId $DeviceId -ConfigPath $ConfigPath
  }

  $newHap = Resolve-LatestHap -ProjectRoot $projectRoot
  $stamp = Get-Date -Format 'yyyyMMdd_HHmmss'
  Copy-HapSnapshot -HapPath $newHap -SnapshotDir $snapshotDir -Name "known-good-$stamp.hap" | Out-Null
  Copy-HapSnapshot -HapPath $newHap -SnapshotDir $snapshotDir -Name 'last-known-good.hap' | Out-Null
  Write-Step "安全部署完成"
  Write-Host "候选版本已通过链路验证，并记录为 last-known-good。" -ForegroundColor Green
} catch {
  Write-Host "安全部署失败: $($_.Exception.Message)" -ForegroundColor Red
  if ($deployed -and (Test-Path -LiteralPath $lastGoodPath)) {
    Write-Step "自动回滚到上一版可用 HAP"
    Invoke-Rollback -ScriptRoot $scriptRoot -RepoRoot $repoRoot -Config $config -DeviceId $DeviceId -GoodHapPath $lastGoodPath -RelayHostedByHelper:$RelayHostedByHelper
    if (-not $SkipSmoke) {
      Invoke-SafeSmoke -ScriptRoot $scriptRoot -BridgeUrl $BridgeUrl -BridgeToken $BridgeToken -DeviceId $DeviceId -ConfigPath $ConfigPath
    }
    Write-Host "已回滚到 last-known-good。" -ForegroundColor Yellow
  }
  exit 1
}
