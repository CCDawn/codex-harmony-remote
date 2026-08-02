[CmdletBinding()]
param(
  [int]$BridgePort = 8787,
  [string]$BridgeToken = $env:CODEX_BRIDGE_TOKEN,
  [string]$BridgeUrl = $env:CODEX_BRIDGE_URL,
  [string]$RuntimeMode = $env:CODEX_BRIDGE_RUNTIME_MODE,
  [string]$CanaryThreadIds = $env:CODEX_BRIDGE_APP_SERVER_CANARY_THREADS,
  [string]$ConfigPath = '',
  [string]$SessionId = '',
  [switch]$SkipHdcRelay,
  [switch]$SkipCodexDesktop,
  [switch]$KeepExistingCodex,
  [switch]$ForceRestart
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$script = Join-Path $repoRoot 'scripts\start-codex-mobile-stack.ps1'
$bridgeConfig = Join-Path $repoRoot 'HarmonyCodexRemote\entry\src\main\ets\config\BridgeConfig.ets'

if (-not (Test-Path -LiteralPath $script)) {
  throw "Missing stack script: $script"
}

if ([string]::IsNullOrWhiteSpace($BridgeToken) -and (Test-Path -LiteralPath $bridgeConfig)) {
  $text = Get-Content -Raw -LiteralPath $bridgeConfig
  $match = [regex]::Match($text, "DEFAULT_BRIDGE_TOKEN:\s*string\s*=\s*'([^']*)'")
  if ($match.Success) {
    $BridgeToken = $match.Groups[1].Value
  }
}

$args = @{
  BridgePort = $BridgePort
  BridgeToken = $BridgeToken
}

if ([string]::IsNullOrWhiteSpace($RuntimeMode)) {
  $RuntimeMode = 'desktop'
}
$args.RuntimeMode = $RuntimeMode
if (-not [string]::IsNullOrWhiteSpace($CanaryThreadIds)) {
  $args.CanaryThreadIds = $CanaryThreadIds
}

if (-not [string]::IsNullOrWhiteSpace($BridgeUrl)) {
  $args.BridgeUrl = $BridgeUrl
}
if (-not [string]::IsNullOrWhiteSpace($ConfigPath)) {
  $args.ConfigPath = $ConfigPath
}
if (-not [string]::IsNullOrWhiteSpace($SessionId)) {
  $args.SessionId = $SessionId
}
if ($SkipHdcRelay) {
  $args.SkipHdcRelay = $true
}
if ($SkipCodexDesktop) {
  $args.SkipCodexDesktop = $true
}
if ($KeepExistingCodex) {
  $args.KeepExistingCodex = $true
}
if ($ForceRestart) {
  $args.ForceRestart = $true
}

& $script @args
