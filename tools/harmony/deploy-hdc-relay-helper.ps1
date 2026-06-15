[CmdletBinding()]
param(
  [switch]$Build,
  [switch]$SkipInstall,
  [switch]$SkipLaunch,
  [string[]]$DeviceId = @(),
  [string]$RelayConfigPath = '',
  [switch]$AllowSharedBundleForProbe
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$mainDeploy = Join-Path $PSScriptRoot 'deploy.ps1'
$configPath = Join-Path $PSScriptRoot 'hdc-relay-helper.config.psd1'
$helperProject = Join-Path $repoRoot 'HarmonyHdcRelayHelper'
$helperAppJson = Join-Path $helperProject 'AppScope\app.json5'
$helperBuildProfile = Join-Path $helperProject 'build-profile.json5'
$helperApp = Get-Content -LiteralPath $helperAppJson -Raw | ConvertFrom-Json
$helperBuild = Get-Content -LiteralPath $helperBuildProfile -Raw | ConvertFrom-Json
$helperBundleName = [string]$helperApp.app.bundleName
$helperProfile = [string]$helperBuild.app.signingConfigs[0].material.profile
if (!$AllowSharedBundleForProbe) {
  & powershell -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'assert-signing-profile.ps1') -ProfilePath $helperProfile -BundleName $helperBundleName
  if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
  }
} else {
  Write-Warning '临时验证模式：允许 Helper 使用当前签名 profile。若包名与主 App 相同，安装主 App 会覆盖 Helper。'
}

if ([string]::IsNullOrWhiteSpace($RelayConfigPath)) {
  $RelayConfigPath = Join-Path $PSScriptRoot 'hdc-relay.local.psd1'
}

if (Test-Path -LiteralPath $RelayConfigPath) {
  $relayConfig = Import-PowerShellDataFile -LiteralPath $RelayConfigPath
  $relayConfigEts = Join-Path $repoRoot 'HarmonyHdcRelayHelper\entry\src\main\ets\config\RelayConfig.ets'
  function Escape-ArkString([string]$Value) {
    return $Value.Replace('\', '\\').Replace("'", "\'")
  }
  function Read-RelayValue([string]$Name, [string]$DefaultValue) {
    if ($relayConfig.ContainsKey($Name) -and $null -ne $relayConfig[$Name]) {
      return [string]$relayConfig[$Name]
    }
    return $DefaultValue
  }
  $relayHost = Escape-ArkString (Read-RelayValue 'RelayHost' '')
  $relayPort = Escape-ArkString (Read-RelayValue 'RelayPort' '19078')
  $deviceIdValue = Escape-ArkString (Read-RelayValue 'DeviceId' 'default')
  $token = Escape-ArkString (Read-RelayValue 'Token' '')
  $hdcdHost = Escape-ArkString (Read-RelayValue 'HdcdHost' '127.0.0.1')
  $hdcdPort = Escape-ArkString (Read-RelayValue 'HdcdPort' '10178')
  $content = @"
export const DEFAULT_RELAY_HOST: string = '$relayHost';
export const DEFAULT_RELAY_PORT: string = '$relayPort';
export const DEFAULT_DEVICE_ID: string = '$deviceIdValue';
export const DEFAULT_RELAY_TOKEN: string = '$token';
export const DEFAULT_HDCD_HOST: string = '$hdcdHost';
export const DEFAULT_HDCD_PORT: string = '$hdcdPort';
"@
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($relayConfigEts, $content, $utf8NoBom)
  Write-Host "已注入 Helper Relay 默认配置: $RelayConfigPath" -ForegroundColor DarkGray
}

$args = @(
  '-ExecutionPolicy', 'Bypass',
  '-File', $mainDeploy,
  '-ConfigPath', $configPath,
  '-ProjectPath', 'HarmonyHdcRelayHelper',
  '-RelayHostedByHelper'
)
if ($Build) {
  $args += '-Build'
}
if ($SkipInstall) {
  $args += '-SkipInstall'
}
if ($SkipLaunch) {
  $args += '-SkipLaunch'
}
foreach ($id in $DeviceId) {
  $args += @('-DeviceId', $id)
}

& powershell @args
