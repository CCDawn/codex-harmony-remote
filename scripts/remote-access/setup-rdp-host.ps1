[CmdletBinding()]
param(
  [switch]$OpenFirewall
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$edition = (Get-ComputerInfo).WindowsEditionId
if ($edition -match 'Core') {
  throw "Current Windows edition is '$edition'. Windows App / Microsoft Remote Desktop requires a Windows Pro/Enterprise/Education RDP host. Upgrade Windows first, then rerun this script."
}

$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  throw 'Run this script from an elevated PowerShell window.'
}

Set-ItemProperty -Path 'HKLM:\System\CurrentControlSet\Control\Terminal Server' -Name 'fDenyTSConnections' -Value 0
Set-Service -Name TermService -StartupType Automatic
Start-Service -Name TermService

if ($OpenFirewall) {
  Enable-NetFirewallRule -DisplayGroup 'Remote Desktop' | Out-Null
}

Write-Host 'RDP host enabled.' -ForegroundColor Green
Write-Host 'Do not expose TCP 3389 directly to the public internet. Use the SSH tunnel scripts instead.'
