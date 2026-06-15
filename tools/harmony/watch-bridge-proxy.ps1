[CmdletBinding()]
param(
  [string]$ConfigPath = '',
  [int]$IntervalSeconds = 8,
  [int]$FailureThreshold = 2
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($ConfigPath)) {
  $ConfigPath = Join-Path $PSScriptRoot 'hdc-relay.local.psd1'
}
if (-not (Test-Path -LiteralPath $ConfigPath)) {
  throw "缺少 HDC Relay 配置: $ConfigPath"
}

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$config = Import-PowerShellDataFile -LiteralPath $ConfigPath
$relayHost = if ($config.RelayHost) { [string]$config.RelayHost } else { '<your-relay-server>' }
$relayPort = if ($config.RelayPort) { [int]$config.RelayPort } else { 19078 }
$relayToken = if ($config.Token) { [string]$config.Token } else { '' }
$bridgeToken = [string]$env:CODEX_BRIDGE_TOKEN
$bridgePort = 8787
$missingCount = 0

function Get-RelayState {
  $url = "http://${relayHost}:${relayPort}/__relay/state?token=$([uri]::EscapeDataString($relayToken))"
  return (Invoke-RestMethod -UseBasicParsing -Uri $url -TimeoutSec 5).state
}

function Test-LocalBridge {
  try {
    Invoke-RestMethod -UseBasicParsing -Uri "http://127.0.0.1:${bridgePort}/health" -Headers @{ 'X-Codex-Bridge-Token' = $bridgeToken } -TimeoutSec 4 | Out-Null
    return $true
  } catch {
    return $false
  }
}

function Stop-BridgeProxy {
  $escapedRepo = [Regex]::Escape([string]$repoRoot)
  $processes = @(Get-CimInstance Win32_Process | Where-Object {
    $commandLine = [string]$_.CommandLine
    if ($_.ProcessId -eq $PID -or [string]::IsNullOrWhiteSpace($commandLine)) {
      return $false
    }
    return $commandLine -match $escapedRepo -and $commandLine -match 'bridge:relay-proxy|start-bridge-proxy\.mjs'
  })
  foreach ($proc in $processes) {
    Write-Host "$(Get-Date -Format o) stop stale bridge-proxy PID=$($proc.ProcessId)" -ForegroundColor Yellow
    Stop-Process -Id ([int]$proc.ProcessId) -Force -ErrorAction SilentlyContinue
  }
}

function Start-BridgeProxy {
  $logRoot = Join-Path ([string]$repoRoot) 'logs\startup'
  New-Item -ItemType Directory -Force -Path $logRoot | Out-Null
  $script = Join-Path $PSScriptRoot 'start-hdc-relay.ps1'
  Start-Process -WindowStyle Hidden -FilePath 'powershell.exe' -ArgumentList @(
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', $script,
    '-Mode', 'BridgeProxy',
    '-ConfigPath', $ConfigPath
  ) -WorkingDirectory ([string]$repoRoot) -RedirectStandardOutput (Join-Path $logRoot 'bridge-proxy.stdout.log') -RedirectStandardError (Join-Path $logRoot 'bridge-proxy.stderr.log') | Out-Null
}

Write-Host "Bridge proxy watchdog started: relay=${relayHost}:$relayPort" -ForegroundColor Green

while ($true) {
  try {
    $state = Get-RelayState
    $bridgePc = [int]$state.bridgePc
    if ($bridgePc -gt 0) {
      if ($missingCount -gt 0) {
        Write-Host "$(Get-Date -Format o) bridge pool recovered: bridgePc=$bridgePc" -ForegroundColor Green
      }
      $missingCount = 0
    } else {
      $missingCount += 1
      Write-Host "$(Get-Date -Format o) bridge pool empty: count=$missingCount" -ForegroundColor Yellow
      if ($missingCount -ge $FailureThreshold -and (Test-LocalBridge)) {
        Write-Host "$(Get-Date -Format o) restart bridge-proxy because public bridge pool is empty" -ForegroundColor Cyan
        Stop-BridgeProxy
        Start-Sleep -Milliseconds 800
        Start-BridgeProxy
        $missingCount = 0
      }
    }
  } catch {
    Write-Host "$(Get-Date -Format o) bridge watchdog check failed: $($_.Exception.Message)" -ForegroundColor Yellow
  }

  Start-Sleep -Seconds $IntervalSeconds
}
