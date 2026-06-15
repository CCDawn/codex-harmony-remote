[CmdletBinding()]
param(
  [string]$BridgeUrl = 'http://127.0.0.1:8787',
  [string]$BridgeToken = $env:CODEX_BRIDGE_TOKEN,
  [string]$SessionId = '',
  [int]$CdpPort = 0
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$BridgeUrl = $BridgeUrl.TrimEnd('/')

function Write-Step {
  param([string]$Message)
  Write-Host ""
  Write-Host "==> $Message" -ForegroundColor Cyan
}

function Write-Info {
  param([string]$Message)
  Write-Host "    $Message" -ForegroundColor DarkGray
}

function Get-BridgeHeaders {
  $headers = @{}
  if (-not [string]::IsNullOrWhiteSpace($BridgeToken)) {
    $headers['X-Codex-Bridge-Token'] = $BridgeToken
  }
  return $headers
}

function Get-ObjectValue {
  param(
    [object]$Object,
    [string]$Name,
    $Fallback
  )

  if ($null -eq $Object) {
    return $Fallback
  }
  $property = $Object.PSObject.Properties[$Name]
  if ($null -eq $property -or $null -eq $property.Value) {
    return $Fallback
  }
  return $property.Value
}

function Invoke-JsonSafe {
  param(
    [string]$Uri,
    [hashtable]$Headers = @{},
    [int]$TimeoutSec = 5
  )

  try {
    $value = Invoke-RestMethod -UseBasicParsing -Uri $Uri -Headers $Headers -TimeoutSec $TimeoutSec
    return [pscustomobject]@{
      Ok = $true
      Value = $value
      Error = ''
    }
  } catch {
    return [pscustomobject]@{
      Ok = $false
      Value = $null
      Error = $_.Exception.Message
    }
  }
}

function Stop-DesktopLiveHost {
  Write-Step "停止旧的桌面 live-host 进程"
  $processes = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    $cmd = [string]$_.CommandLine
    $cmd -match 'start-desktop-cdp-live-host\.mjs'
  })

  foreach ($process in $processes) {
    if ([int]$process.ProcessId -eq $PID) {
      continue
    }
    Write-Info "停止 live-host PID=$($process.ProcessId)"
    Stop-Process -Id ([int]$process.ProcessId) -Force -ErrorAction SilentlyContinue
  }
}

function Add-CandidatePort {
  param(
    [System.Collections.Generic.List[int]]$Ports,
    [int]$Port
  )
  if ($Port -gt 0 -and -not $Ports.Contains($Port)) {
    $Ports.Add($Port) | Out-Null
  }
}

function Get-CandidateCdpPorts {
  $ports = [System.Collections.Generic.List[int]]::new()
  Add-CandidatePort -Ports $ports -Port $CdpPort

  $envPort = 0
  [void][int]::TryParse([string]$env:CODEX_DESKTOP_CDP_PORT, [ref]$envPort)
  Add-CandidatePort -Ports $ports -Port $envPort

  $statusPath = Join-Path $repoRoot 'logs\desktop-live-status.json'
  if (Test-Path -LiteralPath $statusPath) {
    try {
      $status = Get-Content -Raw -LiteralPath $statusPath | ConvertFrom-Json
      $statusPort = 0
      [void][int]::TryParse([string](Get-ObjectValue -Object $status -Name 'cdpPort' -Fallback ''), [ref]$statusPort)
      Add-CandidatePort -Ports $ports -Port $statusPort
    } catch {
      Write-Info "忽略不可读状态文件: $($_.Exception.Message)"
    }
  }

  $processes = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    $cmd = [string]$_.CommandLine
    $cmd -match 'remote-debugging-port='
  })
  foreach ($process in $processes) {
    $cmd = [string]$process.CommandLine
    $match = [regex]::Match($cmd, 'remote-debugging-port=(\d+)')
    if ($match.Success) {
      Add-CandidatePort -Ports $ports -Port ([int]$match.Groups[1].Value)
    }
  }

  Add-CandidatePort -Ports $ports -Port 9229
  return $ports.ToArray()
}

function Test-CdpReady {
  param([int]$Port)

  $lastError = ''
  foreach ($path in @('/json', '/json/list')) {
    $probe = Invoke-JsonSafe -Uri "http://127.0.0.1:$Port$path" -TimeoutSec 2
    if (-not $probe.Ok) {
      $lastError = $probe.Error
      continue
    }
    foreach ($target in @($probe.Value)) {
      $type = [string](Get-ObjectValue -Object $target -Name 'type' -Fallback '')
      $webSocketUrl = [string](Get-ObjectValue -Object $target -Name 'webSocketDebuggerUrl' -Fallback '')
      if ($type -eq 'page' -and -not [string]::IsNullOrWhiteSpace($webSocketUrl)) {
        return [pscustomobject]@{
          Ok = $true
          Port = $Port
          Target = $target
          Error = ''
        }
      }
    }
    $lastError = "CDP $path 没有 page target"
  }
  return [pscustomobject]@{
    Ok = $false
    Port = $Port
    Target = $null
    Error = $lastError
  }
}

function Select-ExistingCdpPort {
  Write-Step "查找现有 Codex CDP 端口"
  $lastError = ''
  foreach ($port in Get-CandidateCdpPorts) {
    $result = Test-CdpReady -Port $port
    if ($result.Ok) {
      Write-Info "复用现有 CDP: http://127.0.0.1:$port"
      return [int]$port
    }
    $lastError = "$($result.Port): $($result.Error)"
  }
  throw "未找到现有 Codex CDP 端口，软恢复已停止，避免重启 Codex。请用桌面一键启动脚本显式启动带 CDP 的 Codex 后重试。最后错误: $lastError"
}

function Wait-DesktopScriptOnline {
  param(
    [int]$TimeoutSeconds = 20
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  $lastStatus = $null
  while ((Get-Date) -lt $deadline) {
    $probe = Invoke-JsonSafe -Uri "$BridgeUrl/desktop/script/status" -Headers (Get-BridgeHeaders) -TimeoutSec 6
    if ($probe.Ok) {
      $lastStatus = $probe.Value
      $bridge = Get-ObjectValue -Object $lastStatus -Name 'bridge' -Fallback $null
      if ([bool](Get-ObjectValue -Object $bridge -Name 'online' -Fallback $false)) {
        return $lastStatus
      }
    } else {
      $lastStatus = @{ error = $probe.Error }
    }
    Start-Sleep -Milliseconds 700
  }
  throw "桌面 live-host 未上线: $($lastStatus | ConvertTo-Json -Depth 8)"
}

function Save-DesktopLiveStatus {
  param(
    [int]$Port,
    [object]$ScriptStatus
  )

  $logsDir = Join-Path $repoRoot 'logs'
  New-Item -ItemType Directory -Force -Path $logsDir | Out-Null
  $path = Join-Path $logsDir 'desktop-live-status.json'
  @{
    status = 'injected'
    mode = 'soft-recover'
    cdpPort = $Port
    bridgeUrl = $BridgeUrl
    scriptStatus = $ScriptStatus
    updatedAt = (Get-Date).ToUniversalTime().ToString('o')
  } | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $path -Encoding UTF8
}

Write-Step "软恢复桌面 Codex live 通道"
Write-Info "此流程只重启本项目 live-host，不停止、不启动 Codex.exe。"
$selectedCdpPort = Select-ExistingCdpPort

Stop-DesktopLiveHost

Write-Step "启动桌面 CDP live-host"
$hostStdout = Join-Path $repoRoot 'logs\startup\desktop-cdp-live-host.stdout.log'
$hostStderr = Join-Path $repoRoot 'logs\startup\desktop-cdp-live-host.stderr.log'
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $hostStdout) | Out-Null
$hostCommand = @"
`$env:CODEX_BRIDGE_URL='$BridgeUrl'
`$env:CODEX_BRIDGE_TOKEN='$BridgeToken'
`$env:CODEX_DESKTOP_CDP_PORT='$selectedCdpPort'
node .\scripts\start-desktop-cdp-live-host.mjs
"@
Start-Process -WindowStyle Hidden -FilePath 'powershell.exe' -ArgumentList @(
  '-NoProfile',
  '-ExecutionPolicy', 'Bypass',
  '-Command', $hostCommand
) -WorkingDirectory $repoRoot -RedirectStandardOutput $hostStdout -RedirectStandardError $hostStderr | Out-Null

Write-Step "验证桌面 live-host 状态"
$scriptStatus = Wait-DesktopScriptOnline -TimeoutSeconds 25
Save-DesktopLiveStatus -Port $selectedCdpPort -ScriptStatus $scriptStatus
$scriptStatus | ConvertTo-Json -Depth 8

if (-not [string]::IsNullOrWhiteSpace($SessionId)) {
  Write-Step "验证目标会话 live 状态"
  $encodedSessionId = [System.Uri]::EscapeDataString($SessionId)
  $liveStatus = Invoke-JsonSafe -Uri "$BridgeUrl/desktop/live/status?sessionId=$encodedSessionId" -Headers (Get-BridgeHeaders) -TimeoutSec 10
  if ($liveStatus.Ok) {
    $liveStatus.Value | ConvertTo-Json -Depth 8
  } else {
    Write-Info "目标会话状态暂不可读: $($liveStatus.Error)"
  }
}
