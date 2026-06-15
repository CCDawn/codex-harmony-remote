[CmdletBinding()]
param(
  [switch]$RestartExplorer,
  [switch]$SkipTunnelRestart,
  [switch]$IsolateRemoteControlApps,
  [switch]$RestartComputerAfterRepair
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
$transcriptFile = Join-Path $logDir ("rdp-0x10b-repair-{0}.log" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
Start-Transcript -LiteralPath $transcriptFile -Force | Out-Null

$policyPath = 'HKLM:\SOFTWARE\Policies\Microsoft\Windows NT\Terminal Services'
$clientPolicyPath = 'HKLM:\SOFTWARE\Policies\Microsoft\Windows NT\Terminal Services\Client'
$rdpTcpPath = 'HKLM:\SYSTEM\CurrentControlSet\Control\Terminal Server\WinStations\RDP-Tcp'

function Set-Dword {
  param([string]$Path, [string]$Name, [int]$Value)
  New-Item -Path $Path -Force | Out-Null
  New-ItemProperty -Path $Path -Name $Name -PropertyType DWord -Value $Value -Force | Out-Null
  Write-Host "Set ${Path}\${Name}=$Value"
}

Write-Host "Repair log: $transcriptFile"
if ($IsolateRemoteControlApps) {
  Write-Host 'Isolating third-party remote-control apps for this RDP test...' -ForegroundColor Yellow
  $serviceNames = @(
    'ToDesk_Service',
    'AnyDesk',
    'RustDesk',
    'SunloginService',
    'SunloginClient',
    'SplashtopRemoteService',
    'Parsec'
  )
  foreach ($serviceName in $serviceNames) {
    $service = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
    if ($service) {
      Write-Host "Stop service $serviceName"
      Stop-Service -Name $serviceName -Force -ErrorAction SilentlyContinue
    }
  }

  $processNames = @(
    'ToDesk',
    'AnyDesk',
    'RustDesk',
    'SunloginClient',
    'SunloginRemote',
    'SunloginServer',
    'Splashtop',
    'SplashtopSOS',
    'parsecd',
    'parsec'
  )
  foreach ($processName in $processNames) {
    $processes = @(Get-Process -Name $processName -ErrorAction SilentlyContinue)
    foreach ($process in $processes) {
      Write-Host "Stop process $($process.ProcessName) PID=$($process.Id)"
      Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    }
  }
}

Write-Host 'Applying RDP 0x10b graphics/session compatibility profile...'
Set-Dword $policyPath 'fEnableWddmDriver' 0
Set-Dword $policyPath 'AVCHardwareEncodePreferred' 0
Set-Dword $policyPath 'AVC444ModePreferred' 0
Set-Dword $policyPath 'bEnumerateHWBeforeSW' 0
Set-Dword $policyPath 'SelectTransport' 1
Set-Dword $policyPath 'SelectNetworkDetect' 3
Set-Dword $clientPolicyPath 'fClientDisableUDP' 1
Set-Dword $rdpTcpPath 'SelectTransport' 1
Set-Dword $rdpTcpPath 'SecurityLayer' 1
Set-Dword $rdpTcpPath 'UserAuthentication' 1
Set-Dword $rdpTcpPath 'MinEncryptionLevel' 2

Write-Host 'Resetting disconnected or stuck RDP sessions...'
$sessions = & query session 2>$null
foreach ($line in $sessions) {
  if ($line -match '^\s*(rdp-tcp#\d+)\s+(\S*)\s+(\d+)\s+(ConnQ|Disc|Down)') {
    Write-Host "Reset session $($matches[3]): $line"
    & rwinsta $matches[3] 2>$null
  }
}

Write-Host 'Restarting Remote Desktop service stack...'
foreach ($svc in @('SessionEnv', 'UmRdpService', 'TermService')) {
  Write-Host "Restart $svc"
  Restart-Service -Name $svc -Force -ErrorAction SilentlyContinue
}

Write-Host 'Refreshing computer policy...'
& gpupdate.exe /target:computer /force | Write-Host

if ($RestartExplorer) {
  Write-Host 'Restarting Explorer shell...'
  Stop-Process -Name explorer -Force -ErrorAction SilentlyContinue
  Start-Process explorer.exe
}

Start-Sleep -Seconds 5
Write-Host 'Current RDP listener state:'
& query session
Get-ItemProperty -Path $rdpTcpPath | Select-Object SecurityLayer,UserAuthentication,SelectTransport,MinEncryptionLevel,PortNumber | Format-List
Get-ItemProperty -Path $policyPath | Select-Object fEnableWddmDriver,SelectTransport,SelectNetworkDetect,AVCHardwareEncodePreferred,AVC444ModePreferred,bEnumerateHWBeforeSW | Format-List

if (-not $SkipTunnelRestart) {
  Write-Host 'Restarting SSH/RDP tunnel stack...'
  $restartScript = Join-Path $scriptRoot 'restart-rdp-tunnels.ps1'
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $restartScript
}

if ($RestartComputerAfterRepair) {
  Write-Host 'RestartComputerAfterRepair requested. Windows will reboot in 10 seconds...' -ForegroundColor Yellow
  Stop-Transcript | Out-Null
  & shutdown.exe /r /t 10 /c 'Codex remote RDP 0x10b repair requested a reboot so RDP graphics policy can take effect.'
  return
}

Write-Host 'RDP 0x10b repair finished. 从 Mac 重新连接 127.0.0.1:3390。'
Stop-Transcript | Out-Null
