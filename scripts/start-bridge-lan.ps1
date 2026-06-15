[CmdletBinding()]
param(
  [int]$Port = 8787,
  [string]$Workspace = '',
  [string]$Adapter = 'codex'
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

Write-Host "Starting Codex bridge on http://0.0.0.0:$Port" -ForegroundColor Cyan
Write-Host "Workspace: $Workspace" -ForegroundColor DarkGray
Write-Host "Adapter: $Adapter" -ForegroundColor DarkGray
Write-Host "Use your Windows LAN IP from the phone, not 127.0.0.1." -ForegroundColor DarkGray
Push-Location $repoRoot
try {
  npm start
} finally {
  Pop-Location
}
