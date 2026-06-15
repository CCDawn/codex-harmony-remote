[CmdletBinding()]
param(
  [int]$Tail = 80,
  [string]$LogDir = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($LogDir)) {
  $LogDir = Join-Path $repoRoot 'logs\current-run'
}

if (-not (Test-Path -LiteralPath $LogDir)) {
  throw "Log directory does not exist: $LogDir"
}

powershell -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'analyze-latest-logs.ps1') -LogDir $LogDir

Get-ChildItem -File -LiteralPath $LogDir -Filter '*.jsonl' | Sort-Object Name | ForEach-Object {
  Write-Host ""
  Write-Host "==> $($_.Name)" -ForegroundColor Cyan
  Get-Content -LiteralPath $_.FullName -Tail $Tail
}
