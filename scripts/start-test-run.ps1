[CmdletBinding()]
param(
  [string]$Label = 'manual-test',
  [string]$BridgeUrl = 'http://127.0.0.1:8787',
  [string]$BridgeToken = '',
  [string]$VirtualConfigPath = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($VirtualConfigPath)) {
  $VirtualConfigPath = Join-Path $repoRoot 'tools\harmony\virtual-hdc.local.psd1'
}

if ($PSBoundParameters.ContainsKey('BridgeUrl') -eq $false -and (Test-Path -LiteralPath $VirtualConfigPath)) {
  $virtual = Import-PowerShellDataFile -LiteralPath $VirtualConfigPath
  if ($virtual.ContainsKey('BridgeUrl') -and -not [string]::IsNullOrWhiteSpace([string]$virtual.BridgeUrl)) {
    $BridgeUrl = [string]$virtual.BridgeUrl
  }
}

$body = @{ label = $Label } | ConvertTo-Json
$headers = @{}
$token = if ([string]::IsNullOrWhiteSpace($BridgeToken)) { [string]$env:CODEX_BRIDGE_TOKEN } else { $BridgeToken }
if (-not [string]::IsNullOrWhiteSpace($token)) {
  $headers['X-Codex-Bridge-Token'] = $token.Trim()
}
$run = Invoke-RestMethod -Method Post -Uri "$BridgeUrl/logs/run" -Body $body -ContentType 'application/json' -Headers $headers

Write-Host "Started log run: $($run.run.runId)" -ForegroundColor Green
Write-Host "Log dir: $(Join-Path $repoRoot 'logs\current-run')" -ForegroundColor DarkGray
