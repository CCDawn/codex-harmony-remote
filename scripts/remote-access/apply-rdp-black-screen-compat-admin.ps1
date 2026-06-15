[CmdletBinding()]
param(
  [switch]$RestartExplorer
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
$transcriptFile = Join-Path $logDir ("rdp-black-screen-compat-{0}.log" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
Start-Transcript -LiteralPath $transcriptFile -Force | Out-Null

$policyPath = 'HKLM:\SOFTWARE\Policies\Microsoft\Windows NT\Terminal Services'
$clientPolicyPath = 'HKLM:\SOFTWARE\Policies\Microsoft\Windows NT\Terminal Services\Client'
$rdpTcpPath = 'HKLM:\SYSTEM\CurrentControlSet\Control\Terminal Server\WinStations\RDP-Tcp'

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

Write-Host "Repair log: $transcriptFile"
Write-Host 'Applying conservative RDP graphics/session compatibility settings...'

# Disable RDP WDDM graphics path and AVC/H.264 variants that commonly produce a black screen on tunneled Mac clients.
Set-Dword $policyPath 'fEnableWddmDriver' 0
Set-Dword $policyPath 'AVCHardwareEncodePreferred' 0
Set-Dword $policyPath 'AVC444ModePreferred' 0
Set-Dword $policyPath 'bEnumerateHWBeforeSW' 0
Set-Dword $policyPath 'SelectTransport' 1
# Windows 11 24H2/Server 2025 RDP can freeze/black-screen during reconnect while probing network quality.
# Value 3 = turn off both connect-time detect and continuous network detect.
Set-Dword $policyPath 'SelectNetworkDetect' 3
Set-Dword $clientPolicyPath 'fClientDisableUDP' 1
Set-Dword $rdpTcpPath 'SelectTransport' 1
Set-Dword $rdpTcpPath 'SecurityLayer' 1
Set-Dword $rdpTcpPath 'UserAuthentication' 1

Write-Host 'Resetting stuck RDP sessions...'
$sessions = & query session 2>$null
foreach ($line in $sessions) {
  if ($line -match '^\s*(rdp-tcp#\d+)\s+(\S*)\s+(\d+)\s+(ConnQ|Disc|Down)') {
    Write-Host "Reset session $($matches[3]): $line"
    & rwinsta $matches[3] 2>$null
  }
}

Write-Host 'Restarting Remote Desktop services...'
foreach ($svc in @('SessionEnv', 'UmRdpService', 'TermService')) {
  Restart-Service -Name $svc -Force -ErrorAction SilentlyContinue
}

Write-Host 'Refreshing computer group policy...'
& gpupdate.exe /target:computer /force | Write-Host

if ($RestartExplorer) {
  Write-Host 'Restarting Explorer shell...'
  Stop-Process -Name explorer -Force -ErrorAction SilentlyContinue
  Start-Process explorer.exe
}

Write-Host 'Current effective Terminal Services policy:'
& reg.exe query 'HKLM\SOFTWARE\Policies\Microsoft\Windows NT\Terminal Services'
& reg.exe query 'HKLM\SOFTWARE\Policies\Microsoft\Windows NT\Terminal Services\Client'

Write-Host 'RDP compatibility fix applied. 请重新从 Mac 连接 127.0.0.1:3390。'
Stop-Transcript | Out-Null
