[CmdletBinding()]
param(
  [int]$BridgePort = 8787,
  [string]$BridgeToken = $env:CODEX_BRIDGE_TOKEN,
  [string]$RuntimeMode = $env:CODEX_BRIDGE_RUNTIME_MODE,
  [string]$CanaryThreadIds = $env:CODEX_BRIDGE_APP_SERVER_CANARY_THREADS,
  [int]$IntervalSeconds = 6,
  [int]$FailureThreshold = 2
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($RuntimeMode)) {
  $RuntimeMode = 'desktop'
}
$RuntimeMode = $RuntimeMode.Trim().ToLowerInvariant()

function Resolve-CompatiblePowerShellHost {
  $currentHost = Get-Process -Id $PID -ErrorAction SilentlyContinue
  if ($currentHost -and -not [string]::IsNullOrWhiteSpace([string]$currentHost.Path) -and (Test-Path -LiteralPath ([string]$currentHost.Path))) {
    return [string]$currentHost.Path
  }

  $pwsh = Get-Command pwsh.exe -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($pwsh -and -not [string]::IsNullOrWhiteSpace([string]$pwsh.Source) -and (Test-Path -LiteralPath ([string]$pwsh.Source))) {
    return [string]$pwsh.Source
  }

  throw '未找到可用的 PowerShell 主机'
}

$powerShellHostPath = Resolve-CompatiblePowerShellHost
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$bridgeConfigPath = Join-Path ([string]$repoRoot) 'HarmonyCodexRemote\entry\src\main\ets\config\BridgeConfig.ets'
if ([string]::IsNullOrWhiteSpace($BridgeToken) -and (Test-Path -LiteralPath $bridgeConfigPath)) {
  $bridgeConfigText = Get-Content -Raw -LiteralPath $bridgeConfigPath
  $bridgeTokenMatch = [regex]::Match($bridgeConfigText, "DEFAULT_BRIDGE_TOKEN:\s*string\s*=\s*'([^']*)'")
  if ($bridgeTokenMatch.Success) {
    $BridgeToken = $bridgeTokenMatch.Groups[1].Value
  }
}
$logRoot = Join-Path ([string]$repoRoot) 'logs\startup'
New-Item -ItemType Directory -Force -Path $logRoot | Out-Null
$missingCount = 0

function Write-WatchLog {
  param([string]$Message)
  Write-Host "$(Get-Date -Format o) $Message"
}

function Test-LocalBridge {
  try {
    $health = Invoke-RestMethod -UseBasicParsing `
      -Uri "http://127.0.0.1:${BridgePort}/health" `
      -Headers @{ 'X-Codex-Bridge-Token' = $BridgeToken } `
      -TimeoutSec 4
    $actualMode = [string]$health.runtime.mode
    if ($actualMode -ne $RuntimeMode) {
      Write-WatchLog "local bridge runtime mismatch: expected=$RuntimeMode actual=$actualMode"
      return $false
    }
    return $true
  } catch {
    return $false
  }
}

function Stop-LocalBridge {
  $escapedRepo = [Regex]::Escape([string]$repoRoot)
  $processes = @(Get-CimInstance Win32_Process | Where-Object {
    $commandLine = [string]$_.CommandLine
    if ($_.ProcessId -eq $PID -or [string]::IsNullOrWhiteSpace($commandLine)) {
      return $false
    }
    return $commandLine -match $escapedRepo -and $commandLine -match 'src[\\/]server\.js'
  })
  foreach ($proc in $processes) {
    Write-WatchLog "stop stale local bridge PID=$($proc.ProcessId)"
    Stop-Process -Id ([int]$proc.ProcessId) -Force -ErrorAction SilentlyContinue
  }
}

function Stop-BridgePortOwner {
  $listeners = @(Get-NetTCPConnection -LocalPort $BridgePort -State Listen -ErrorAction SilentlyContinue)
  foreach ($listener in $listeners) {
    $ownerPid = [int]$listener.OwningProcess
    if ($ownerPid -eq 0 -or $ownerPid -eq $PID) {
      continue
    }

    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $ownerPid" -ErrorAction SilentlyContinue
    if ($null -eq $process) {
      continue
    }

    $commandLine = [string]$process.CommandLine
    if ($commandLine -match 'src[\\/]server\.js') {
      Write-WatchLog "stop local bridge port owner PID=$ownerPid port=$BridgePort"
      Stop-Process -Id $ownerPid -Force -ErrorAction SilentlyContinue
    } else {
      Write-WatchLog "port $BridgePort is owned by PID=$ownerPid, but it is not Codex bridge; skip"
    }
  }
}

function Start-LocalBridge {
  $stdout = Join-Path $logRoot 'bridge.stdout.log'
  $stderr = Join-Path $logRoot 'bridge.stderr.log'
  $command = @"
`$env:CODEX_BRIDGE_HOST='0.0.0.0'
`$env:CODEX_BRIDGE_PORT='$BridgePort'
`$env:CODEX_BRIDGE_WORKSPACE='$repoRoot'
`$env:CODEX_BRIDGE_TOKEN='$BridgeToken'
`$env:CODEX_BRIDGE_ADAPTER='codex'
`$env:CODEX_BRIDGE_RUNTIME_MODE='$RuntimeMode'
`$env:CODEX_BRIDGE_APP_SERVER_CANARY_THREADS='$CanaryThreadIds'
node src/server.js
"@
  Write-WatchLog "start local bridge on 127.0.0.1:${BridgePort}"
  Start-Process -WindowStyle Hidden -FilePath $powerShellHostPath -ArgumentList @(
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-Command', $command
  ) -WorkingDirectory ([string]$repoRoot) -RedirectStandardOutput $stdout -RedirectStandardError $stderr | Out-Null
}

Write-WatchLog "local bridge watchdog started: http://127.0.0.1:${BridgePort}; mode=$RuntimeMode"

while ($true) {
  if (Test-LocalBridge) {
    if ($missingCount -gt 0) {
      Write-WatchLog "local bridge recovered"
    }
    $missingCount = 0
  } else {
    $missingCount += 1
    Write-WatchLog "local bridge is offline: count=$missingCount"
    if ($missingCount -ge $FailureThreshold) {
      Stop-LocalBridge
      Stop-BridgePortOwner
      Start-Sleep -Milliseconds 800
      Start-LocalBridge
      $missingCount = 0
    }
  }

  Start-Sleep -Seconds $IntervalSeconds
}
