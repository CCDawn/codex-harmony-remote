[CmdletBinding()]
param(
  [string]$ConfigPath = '',
  [switch]$NoProxyStart,
  [switch]$Watch,
  [int]$WatchSeconds = 10
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Resolve-CompatiblePowerShellHost {
  $currentHost = Get-Process -Id $PID -ErrorAction SilentlyContinue
  if ($currentHost -and -not [string]::IsNullOrWhiteSpace([string]$currentHost.Path) -and (Test-Path -LiteralPath ([string]$currentHost.Path))) {
    return [string]$currentHost.Path
  }
  $pwsh = Get-Command pwsh.exe -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($pwsh -and -not [string]::IsNullOrWhiteSpace([string]$pwsh.Source) -and (Test-Path -LiteralPath ([string]$pwsh.Source))) {
    return [string]$pwsh.Source
  }
  $legacy = Get-Command powershell.exe -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($legacy -and -not [string]::IsNullOrWhiteSpace([string]$legacy.Source) -and (Test-Path -LiteralPath ([string]$legacy.Source))) {
    return [string]$legacy.Source
  }
  throw '未找到可用的 PowerShell 主机'
}

$powerShellHostPath = Resolve-CompatiblePowerShellHost

if ([string]::IsNullOrWhiteSpace($ConfigPath)) {
  $ConfigPath = Join-Path $PSScriptRoot 'hdc-relay.local.psd1'
}
if (!(Test-Path -LiteralPath $ConfigPath)) {
  throw "Missing config: $ConfigPath. Copy hdc-relay.example.psd1 to hdc-relay.local.psd1 first."
}

$config = Import-PowerShellDataFile -LiteralPath $ConfigPath
$proxyHost = if ($config.ProxyHost) { $config.ProxyHost } else { '127.0.0.1' }
$proxyPort = if ($config.ProxyPort) { [int]$config.ProxyPort } else { 11078 }
$hdcPath = if ($config.HdcPath) { $config.HdcPath } else { 'C:\openHarmony\20\toolchains\hdc.exe' }

if (!(Test-Path -LiteralPath $hdcPath)) {
  throw "HDC executable not found: $hdcPath"
}

function Start-RelayProxy {
  if ($NoProxyStart) {
    return
  }
  $listener = Get-NetTCPConnection -LocalAddress $proxyHost -LocalPort $proxyPort -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($listener) {
    return
  }
  $logDir = Join-Path (Resolve-Path (Join-Path $PSScriptRoot '..\..')) 'logs\hdc-relay'
  New-Item -ItemType Directory -Force -Path $logDir | Out-Null
  $stdout = Join-Path $logDir 'local-proxy.stdout.log'
  $stderr = Join-Path $logDir 'local-proxy.stderr.log'
  $scriptPath = Join-Path $PSScriptRoot 'start-hdc-relay.ps1'
  Start-Process -WindowStyle Hidden -FilePath $powerShellHostPath -ArgumentList @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-File', $scriptPath,
    '-Mode', 'Proxy',
    '-ConfigPath', $ConfigPath
  ) -RedirectStandardOutput $stdout -RedirectStandardError $stderr
  Start-Sleep -Seconds 2
  $listener = Get-NetTCPConnection -LocalAddress $proxyHost -LocalPort $proxyPort -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $listener) {
    throw "本地 HDC Relay Proxy 未能监听 ${proxyHost}:$proxyPort，请查看 $stderr"
  }
}

function Restart-RelayProxy {
  if ($NoProxyStart) {
    return
  }
  Get-NetTCPConnection -LocalAddress $proxyHost -LocalPort $proxyPort -State Listen -ErrorAction SilentlyContinue | ForEach-Object {
    Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue
  }
  Start-Sleep -Seconds 1
  Start-RelayProxy
}

function Test-RelayTarget {
  $target = "${proxyHost}:$proxyPort"
  $targets = @(& $hdcPath list targets 2>&1)
  if ((($targets -join "`n") -notmatch [Regex]::Escape($target))) {
    return $false
  }
  $probe = @(& $hdcPath -t $target shell 'echo relay-hdc-ok' 2>&1)
  return ($LASTEXITCODE -eq 0 -and (($probe -join "`n") -match 'relay-hdc-ok'))
}

function Connect-RelayTarget {
  Start-RelayProxy
  $target = "${proxyHost}:$proxyPort"
  & $hdcPath kill -r | Out-Null
  Start-Sleep -Seconds 1
  & $hdcPath tconn $target | Out-Host
  & $hdcPath list targets | Out-Host
}

Connect-RelayTarget

if (-not $Watch) {
  return
}

Write-Host "Watching relay HDC target ${proxyHost}:$proxyPort every $WatchSeconds seconds." -ForegroundColor Cyan
while ($true) {
  Start-Sleep -Seconds $WatchSeconds
  try {
    if (-not (Test-RelayTarget)) {
      Write-Host "Relay HDC target offline, reconnecting..." -ForegroundColor Yellow
      Restart-RelayProxy
      Connect-RelayTarget
    }
  } catch {
    Write-Host "Relay HDC watchdog error: $($_.Exception.Message)" -ForegroundColor Yellow
  }
}
