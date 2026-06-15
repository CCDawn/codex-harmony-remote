[CmdletBinding()]
param(
  [switch]$SetupUsbTcp,
  [switch]$NoBuild,
  [switch]$Watch,
  [string]$VirtualConfigPath = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
if ([string]::IsNullOrWhiteSpace($VirtualConfigPath)) {
  $VirtualConfigPath = Join-Path $scriptRoot 'virtual-hdc.local.psd1'
}

$args = @('-ExecutionPolicy', 'Bypass', '-File', (Join-Path $scriptRoot 'auto-dev.ps1'), '-VirtualConfigPath', $VirtualConfigPath)
if ($SetupUsbTcp) {
  $args += '-SetupUsbTcp'
}
if ($NoBuild) {
  $args += '-NoBuild'
}
if ($Watch) {
  $args += '-Watch'
}

& powershell @args
