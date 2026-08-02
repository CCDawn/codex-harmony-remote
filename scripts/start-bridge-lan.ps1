[CmdletBinding()]
param(
  [int]$Port = 8787,
  [string]$Workspace = '',
  [string]$Adapter = 'codex',
  [string]$RuntimeMode = $env:CODEX_BRIDGE_RUNTIME_MODE,
  [string]$CanaryThreadIds = $env:CODEX_BRIDGE_APP_SERVER_CANARY_THREADS
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($Workspace)) {
  $Workspace = $repoRoot
}
$env:CODEX_BRIDGE_HOST = '0.0.0.0'
$env:CODEX_BRIDGE_PORT = [string]$Port
$env:CODEX_BRIDGE_WORKSPACE = $Workspace
$env:CODEX_BRIDGE_ADAPTER = $Adapter
if ([string]::IsNullOrWhiteSpace($RuntimeMode)) {
  $RuntimeMode = 'desktop'
}
$env:CODEX_BRIDGE_RUNTIME_MODE = $RuntimeMode
$env:CODEX_BRIDGE_APP_SERVER_CANARY_THREADS = $CanaryThreadIds

Write-Host "Starting Codex bridge on http://0.0.0.0:$Port" -ForegroundColor Cyan
Write-Host "Workspace: $Workspace" -ForegroundColor DarkGray
Write-Host "Adapter: $Adapter" -ForegroundColor DarkGray
Write-Host "Runtime: $RuntimeMode" -ForegroundColor DarkGray
Write-Host "Use your Windows LAN IP from the phone, not 127.0.0.1." -ForegroundColor DarkGray
Push-Location $repoRoot
try {
  npm start
} finally {
  Pop-Location
}
