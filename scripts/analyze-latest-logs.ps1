[CmdletBinding()]
param(
  [string]$LogDir = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($LogDir)) {
  $LogDir = Join-Path $repoRoot 'logs\current-run'
}
$script = @'
import { analyzeLogRun } from './src/logAnalyzer.js';
const summary = await analyzeLogRun(process.argv[1]);
console.log(`Health: ${summary.health.status} - ${summary.health.reason}`);
console.log(`Entries: ${summary.totals.entries}`);
console.log(`Summary: ${process.argv[1]}\\summary.md`);
'@

Push-Location $repoRoot
try {
  node --input-type=module -e $script $LogDir
} finally {
  Pop-Location
}
