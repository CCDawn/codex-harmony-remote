[CmdletBinding()]
param(
  [switch]$SkipTunnelRestart
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path

Write-Host 'Checking RDP session state...'
$sessions = & query session 2>$null
foreach ($line in $sessions) {
  if ($line -match '^\s*(rdp-tcp#\d+)\s+(\S*)\s+(\d+)\s+(ConnQ|Disc|Down)') {
    Write-Host "Reset stale RDP session $($matches[3]): $line"
    & rwinsta $matches[3] 2>$null
  }
}

Write-Host 'Checking local RDP listener...'
$rdpListening = Get-NetTCPConnection -LocalPort 3389 -State Listen -ErrorAction SilentlyContinue |
  Where-Object { $_.LocalAddress -eq '127.0.0.1' -or $_.LocalAddress -eq '0.0.0.0' -or $_.LocalAddress -eq '::' } |
  Select-Object -First 1
if (-not $rdpListening) {
  Write-Host 'Local RDP listener is not ready on port 3389.' -ForegroundColor Yellow
} else {
  Write-Host "Local RDP listener is ready: $($rdpListening.LocalAddress):$($rdpListening.LocalPort)"
}

if (-not $SkipTunnelRestart) {
  $restartScript = Join-Path $scriptRoot 'restart-rdp-tunnels.ps1'
  Write-Host 'Refreshing SSH/RDP tunnels...'
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $restartScript
}

Write-Host 'Preflight finished. Connect from Mac Windows App to 127.0.0.1:3390.'
