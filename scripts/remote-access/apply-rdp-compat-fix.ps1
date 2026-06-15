[CmdletBinding()]
param(
  [switch]$Restore,
  [string]$BackupPath,
  [switch]$RestartService
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  throw 'Run this script from an elevated PowerShell window.'
}

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$logDir = Join-Path $repoRoot 'logs\remote-access'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

$policyPath = 'HKLM:\SOFTWARE\Policies\Microsoft\Windows NT\Terminal Services'
$policyKey = 'HKLM\SOFTWARE\Policies\Microsoft\Windows NT\Terminal Services'
$values = @(
  'fEnableWddmDriver',
  'AVCHardwareEncodePreferred',
  'AVC444ModePreferred',
  'bEnumerateHWBeforeSW',
  'SelectTransport'
)

function Get-RegistrySnapshot {
  $item = Get-ItemProperty -Path $policyPath -ErrorAction SilentlyContinue
  $snapshot = [ordered]@{}
  foreach ($name in $values) {
    if ($null -ne $item -and $item.PSObject.Properties.Name -contains $name) {
      $snapshot[$name] = [ordered]@{
        Exists = $true
        Value = $item.$name
      }
    } else {
      $snapshot[$name] = [ordered]@{
        Exists = $false
        Value = $null
      }
    }
  }
  return $snapshot
}

function Restart-RdpServiceIfRequested {
  if (-not $RestartService) {
    Write-Host 'Policy values updated. Reboot Windows or rerun with -RestartService to apply immediately.' -ForegroundColor Yellow
    return
  }

  Write-Host 'Restarting Remote Desktop Services...' -ForegroundColor Cyan
  Restart-Service -Name TermService -Force
}

if ($Restore) {
  if (-not $BackupPath) {
    $BackupPath = Get-ChildItem -LiteralPath $logDir -Filter 'rdp-compat-backup-*.json' -ErrorAction SilentlyContinue |
      Sort-Object LastWriteTime -Descending |
      Select-Object -First 1 -ExpandProperty FullName
  }
  if (-not $BackupPath -or -not (Test-Path -LiteralPath $BackupPath)) {
    throw 'No backup file found. Pass -BackupPath explicitly.'
  }

  $backup = Get-Content -LiteralPath $BackupPath -Raw | ConvertFrom-Json
  New-Item -Path $policyPath -Force | Out-Null
  foreach ($name in $values) {
    $entry = $backup.Values.$name
    if ($entry.Exists) {
      New-ItemProperty -Path $policyPath -Name $name -PropertyType DWord -Value ([int]$entry.Value) -Force | Out-Null
      Write-Host "Restored ${name}=$($entry.Value)"
    } else {
      Remove-ItemProperty -Path $policyPath -Name $name -ErrorAction SilentlyContinue
      Write-Host "Removed ${name}"
    }
  }
  Restart-RdpServiceIfRequested
  Write-Host "RDP compatibility policy restored from $BackupPath" -ForegroundColor Green
  exit 0
}

$backupFile = Join-Path $logDir ("rdp-compat-backup-{0}.json" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
$backupObject = [ordered]@{
  CreatedAt = (Get-Date -Format o)
  RegistryKey = $policyKey
  Values = Get-RegistrySnapshot
}
$backupObject | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $backupFile -Encoding UTF8

New-Item -Path $policyPath -Force | Out-Null

# Conservative RDP graphics profile for Mac Windows App over SSH tunnels.
# These are official TerminalServer ADMX-backed policy values.
$desired = [ordered]@{
  fEnableWddmDriver = 0
  AVCHardwareEncodePreferred = 0
  AVC444ModePreferred = 0
  bEnumerateHWBeforeSW = 0
  SelectTransport = 1
}

foreach ($entry in $desired.GetEnumerator()) {
  New-ItemProperty -Path $policyPath -Name $entry.Key -PropertyType DWord -Value ([int]$entry.Value) -Force | Out-Null
  Write-Host "Set $($entry.Key)=$($entry.Value)"
}

Restart-RdpServiceIfRequested

Write-Host "Backup saved: $backupFile" -ForegroundColor Cyan
Write-Host 'RDP compatibility policy applied.' -ForegroundColor Green
