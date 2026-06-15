[CmdletBinding()]
param(
  [switch]$RestartTunnels
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

$backupFile = Join-Path $logDir ("rdp-tcp-listener-backup-{0}.reg" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
$transcriptFile = Join-Path $logDir ("rdp-listener-repair-{0}.log" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
$restoreRegFile = Join-Path $scriptRoot 'RDP-Tcp-Restore-Windows11.reg'
$rdpTcpReg = 'HKLM\SYSTEM\CurrentControlSet\Control\Terminal Server\WinStations\RDP-Tcp'
$rdpTcpPath = 'HKLM:\SYSTEM\CurrentControlSet\Control\Terminal Server\WinStations\RDP-Tcp'
$terminalServerPath = 'HKLM:\SYSTEM\CurrentControlSet\Control\Terminal Server'
$policyPath = 'HKLM:\SOFTWARE\Policies\Microsoft\Windows NT\Terminal Services'
$clientPolicyPath = 'HKLM:\SOFTWARE\Policies\Microsoft\Windows NT\Terminal Services\Client'

Start-Transcript -LiteralPath $transcriptFile -Force | Out-Null
Write-Host "Repair log: $transcriptFile"

Write-Host "Backing up RDP-Tcp registry to: $backupFile"
& reg.exe export $rdpTcpReg $backupFile /y | Out-Null

function Set-Dword {
  param(
    [Parameter(Mandatory)] [string]$Path,
    [Parameter(Mandatory)] [string]$Name,
    [Parameter(Mandatory)] [int]$Value
  )
  if (-not (Test-Path -LiteralPath $Path)) {
    New-Item -Path $Path -Force | Out-Null
  }
  if ((Get-ItemProperty -Path $Path -Name $Name -ErrorAction SilentlyContinue) -ne $null) {
    Set-ItemProperty -Path $Path -Name $Name -Value $Value
  } else {
    New-ItemProperty -Path $Path -Name $Name -PropertyType DWord -Value $Value | Out-Null
  }
  Write-Host "Set ${Path}\${Name}=$Value"
}

if (-not (Test-Path -LiteralPath $restoreRegFile)) {
  throw "缺少恢复模板: $restoreRegFile"
}

Write-Host 'Stopping Remote Desktop services before registry restore...'
foreach ($svc in @('SessionEnv', 'UmRdpService', 'TermService')) {
  Stop-Service -Name $svc -Force -ErrorAction SilentlyContinue
}

Write-Host "Importing full RDP-Tcp listener template: $restoreRegFile"
& reg.exe import $restoreRegFile
if ($LASTEXITCODE -ne 0) {
  throw "reg import failed: exit=$LASTEXITCODE"
}

Write-Host 'Restoring core Remote Desktop listener settings...'
Set-Dword $terminalServerPath 'fDenyTSConnections' 0
Set-Dword $rdpTcpPath 'PortNumber' 3389
Set-Dword $rdpTcpPath 'UserAuthentication' 1
Set-Dword $rdpTcpPath 'SecurityLayer' 1
Set-Dword $rdpTcpPath 'MinEncryptionLevel' 2
Set-Dword $rdpTcpPath 'SelectTransport' 1
Set-Dword $rdpTcpPath 'LanAdapter' 0
Set-Dword $rdpTcpPath 'fEnableWinStation' 1

Write-Host 'Keeping conservative graphics/transport settings for Mac Windows App...'
Set-Dword $policyPath 'fEnableWddmDriver' 0
Set-Dword $policyPath 'AVCHardwareEncodePreferred' 0
Set-Dword $policyPath 'AVC444ModePreferred' 0
Set-Dword $policyPath 'bEnumerateHWBeforeSW' 0
Set-Dword $policyPath 'SelectTransport' 1
Set-Dword $clientPolicyPath 'fClientDisableUDP' 1

Write-Host 'Enabling Remote Desktop firewall group...'
Enable-NetFirewallRule -DisplayGroup 'Remote Desktop' -ErrorAction SilentlyContinue
Enable-NetFirewallRule -DisplayGroup '远程桌面' -ErrorAction SilentlyContinue

Write-Host 'Restarting Remote Desktop services...'
foreach ($svc in @('TermService', 'UmRdpService', 'SessionEnv')) {
  Start-Service -Name $svc -ErrorAction SilentlyContinue
}

Write-Host 'Waiting for 127.0.0.1:3389 listener...'
$listening = $false
for ($i = 1; $i -le 30; $i++) {
  Start-Sleep -Seconds 1
  $conn = Get-NetTCPConnection -LocalPort 3389 -State Listen -ErrorAction SilentlyContinue
  if ($conn) {
    $listening = $true
    break
  }
}

if (-not $listening) {
  Write-Host 'RDP listener is still not up. Current service state:'
  Get-Service TermService,SessionEnv,UmRdpService | Format-Table Name,Status,StartType
  Write-Host 'Current RDP-Tcp registry:'
  & reg.exe query $rdpTcpReg
  Write-Host '建议重启 Windows 后再运行一次本脚本；如果仍失败，再检查事件日志 TermService/RemoteDesktopServices。'
  Stop-Transcript | Out-Null
  exit 2
}

Write-Host 'RDP listener is ready on 127.0.0.1:3389.'
Write-Host 'Current RDP-Tcp registry essentials:'
& reg.exe query $rdpTcpReg /v PortNumber
& reg.exe query $rdpTcpReg /v LoadableProtocol_Object
& reg.exe query $rdpTcpReg /v WdName

if ($RestartTunnels) {
  $restartScript = Join-Path $scriptRoot 'restart-rdp-tunnels.ps1'
  if (Test-Path -LiteralPath $restartScript) {
    Write-Host 'Restarting RDP SSH tunnels...'
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $restartScript
  }
}

Write-Host 'Done. Mac 端请连接 127.0.0.1:3390，或打开桌面的 Windows-via-server-safe-1920x1200.rdp。'
Stop-Transcript | Out-Null
