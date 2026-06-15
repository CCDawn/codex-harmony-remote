[CmdletBinding()]
param(
  [switch]$RestartExplorer,
  [switch]$Restore,
  [string]$BackupPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  throw '请在“以管理员身份运行”的 PowerShell 中执行这个脚本。'
}

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent (Split-Path -Parent $scriptRoot)
$logDir = Join-Path $repoRoot 'logs\remote-access'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

$policyPath = 'HKLM:\SOFTWARE\Policies\Microsoft\Windows NT\Terminal Services'
$clientPolicyPath = 'HKLM:\SOFTWARE\Policies\Microsoft\Windows NT\Terminal Services\Client'
$rdpTcpPath = 'HKLM:\SYSTEM\CurrentControlSet\Control\Terminal Server\WinStations\RDP-Tcp'
$servicesToQuiesce = @('ROG Live Service')
$servicesToRestart = @('SessionEnv', 'UmRdpService', 'TermService')

function Get-RegistryValueState {
  param([string]$Path, [string]$Name)
  $item = Get-ItemProperty -Path $Path -ErrorAction SilentlyContinue
  if ($item -and $item.PSObject.Properties.Name -contains $Name) {
    return [ordered]@{ Exists = $true; Value = $item.$Name }
  }
  return [ordered]@{ Exists = $false; Value = $null }
}

function Set-Dword {
  param([string]$Path, [string]$Name, [int]$Value)
  New-Item -Path $Path -Force | Out-Null
  New-ItemProperty -Path $Path -Name $Name -PropertyType DWord -Value $Value -Force | Out-Null
  Write-Host "Set ${Path}\${Name}=$Value"
}

function Restore-Dword {
  param([string]$Path, [string]$Name, [object]$State)
  New-Item -Path $Path -Force | Out-Null
  if ($State.Exists) {
    New-ItemProperty -Path $Path -Name $Name -PropertyType DWord -Value ([int]$State.Value) -Force | Out-Null
    Write-Host "Restored ${Path}\${Name}=$($State.Value)"
  } else {
    Remove-ItemProperty -Path $Path -Name $Name -ErrorAction SilentlyContinue
    Write-Host "Removed ${Path}\${Name}"
  }
}

function Get-ServiceState {
  param([string]$Name)
  $svc = Get-Service -Name $Name -ErrorAction SilentlyContinue
  if (-not $svc) {
    return [ordered]@{ Exists = $false; Status = $null; StartType = $null }
  }
  $wmi = Get-CimInstance Win32_Service -Filter ("Name='{0}'" -f ($Name -replace "'", "''")) -ErrorAction SilentlyContinue
  return [ordered]@{
    Exists = $true
    Status = "$($svc.Status)"
    StartType = if ($wmi) { "$($wmi.StartMode)" } else { "$($svc.StartType)" }
  }
}

if ($Restore) {
  if (-not $BackupPath) {
    $BackupPath = Get-ChildItem -LiteralPath $logDir -Filter 'rdp-black-screen-backup-*.json' -ErrorAction SilentlyContinue |
      Sort-Object LastWriteTime -Descending |
      Select-Object -First 1 -ExpandProperty FullName
  }
  if (-not $BackupPath -or -not (Test-Path -LiteralPath $BackupPath)) {
    throw '没有找到备份文件。请传入 -BackupPath，或确认 logs\remote-access 下存在 rdp-black-screen-backup-*.json。'
  }

  $backup = Get-Content -LiteralPath $BackupPath -Raw | ConvertFrom-Json
  foreach ($entry in $backup.Registry.PSObject.Properties) {
    foreach ($valueEntry in $entry.Value.PSObject.Properties) {
      Restore-Dword -Path $entry.Name -Name $valueEntry.Name -State $valueEntry.Value
    }
  }

  foreach ($svcEntry in $backup.Services.PSObject.Properties) {
    $state = $svcEntry.Value
    if ($state.Exists) {
      $startup = switch ($state.StartType) {
        'Auto' { 'Automatic' }
        'Automatic' { 'Automatic' }
        'Manual' { 'Manual' }
        'Disabled' { 'Disabled' }
        default { 'Manual' }
      }
      Set-Service -Name $svcEntry.Name -StartupType $startup -ErrorAction SilentlyContinue
      if ($state.Status -eq 'Running') {
        Start-Service -Name $svcEntry.Name -ErrorAction SilentlyContinue
      }
      Write-Host "Restored service $($svcEntry.Name) startup=$startup targetStatus=$($state.Status)"
    }
  }

  Restart-Service -Name TermService -Force -ErrorAction SilentlyContinue
  Write-Host "Restored from $BackupPath"
  exit 0
}

$backupFile = Join-Path $logDir ("rdp-black-screen-backup-{0}.json" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
$backup = [ordered]@{
  CreatedAt = (Get-Date -Format o)
  Registry = [ordered]@{
    $policyPath = [ordered]@{
      fEnableWddmDriver = Get-RegistryValueState $policyPath 'fEnableWddmDriver'
      AVCHardwareEncodePreferred = Get-RegistryValueState $policyPath 'AVCHardwareEncodePreferred'
      AVC444ModePreferred = Get-RegistryValueState $policyPath 'AVC444ModePreferred'
      bEnumerateHWBeforeSW = Get-RegistryValueState $policyPath 'bEnumerateHWBeforeSW'
      SelectTransport = Get-RegistryValueState $policyPath 'SelectTransport'
    }
    $clientPolicyPath = [ordered]@{
      fClientDisableUDP = Get-RegistryValueState $clientPolicyPath 'fClientDisableUDP'
    }
    $rdpTcpPath = [ordered]@{
      SelectTransport = Get-RegistryValueState $rdpTcpPath 'SelectTransport'
    }
  }
  Services = [ordered]@{}
}
foreach ($svc in $servicesToQuiesce) {
  $backup.Services[$svc] = Get-ServiceState $svc
}
$backup | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $backupFile -Encoding UTF8
Write-Host "Backup saved: $backupFile"

# Conservative RDP profile for Mac Windows App over SSH tunnels.
# Force TCP and legacy/software rendering path; avoid AVC/H.264/444 and WDDM startup issues.
Set-Dword $policyPath 'fEnableWddmDriver' 0
Set-Dword $policyPath 'AVCHardwareEncodePreferred' 0
Set-Dword $policyPath 'AVC444ModePreferred' 0
Set-Dword $policyPath 'bEnumerateHWBeforeSW' 0
Set-Dword $policyPath 'SelectTransport' 1
Set-Dword $clientPolicyPath 'fClientDisableUDP' 1
Set-Dword $rdpTcpPath 'SelectTransport' 1

foreach ($svc in $servicesToQuiesce) {
  $service = Get-Service -Name $svc -ErrorAction SilentlyContinue
  if ($service) {
    Write-Host "Stopping noisy service: $svc"
    Stop-Service -Name $svc -Force -ErrorAction SilentlyContinue
    Set-Service -Name $svc -StartupType Disabled -ErrorAction SilentlyContinue
  }
}

Write-Host 'Resetting stuck RDP sessions...'
$sessions = & query session 2>$null
foreach ($line in $sessions) {
  if ($line -match '^\s*(rdp-tcp#\d+)\s+(\S*)\s+(\d+)\s+(ConnQ|Disc)') {
    & rwinsta $matches[3] 2>$null
  }
}

Write-Host 'Restarting Remote Desktop services...'
foreach ($svc in $servicesToRestart) {
  Restart-Service -Name $svc -Force -ErrorAction SilentlyContinue
}

if ($RestartExplorer) {
  Write-Host 'Restarting Explorer...'
  Stop-Process -Name explorer -Force -ErrorAction SilentlyContinue
  Start-Process explorer.exe
}

Write-Host 'RDP black-screen repair applied.'
Write-Host '请等待 10 秒后，从 Mac 桌面的 Windows-via-server-safe-1920x1200.rdp 重新连接。'
