[CmdletBinding()]
param(
  [int]$BridgePort = 8787,
  [string]$BridgeToken = $env:CODEX_BRIDGE_TOKEN,
  [string]$BridgeUrl = '',
  [string]$ConfigPath = '',
  [string]$SessionId = '',
  [switch]$SkipHdcRelay,
  [switch]$SkipCodexDesktop,
  [switch]$KeepExistingCodex,
  [switch]$ForceRestart
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($BridgeUrl)) {
  $BridgeUrl = "http://127.0.0.1:$BridgePort"
}
$BridgeUrl = $BridgeUrl.TrimEnd('/')
if ([string]::IsNullOrWhiteSpace($ConfigPath)) {
  $ConfigPath = Join-Path $repoRoot 'tools\harmony\hdc-relay.local.psd1'
}

$logRoot = Join-Path $repoRoot 'logs\startup'
New-Item -ItemType Directory -Force -Path $logRoot | Out-Null

function Write-Step {
  param([string]$Message)
  Write-Host ""
  Write-Host "==> $Message" -ForegroundColor Cyan
}

function Write-Info {
  param([string]$Message)
  Write-Host "    $Message" -ForegroundColor DarkGray
}

function Write-Warn {
  param([string]$Message)
  Write-Host "    $Message" -ForegroundColor Yellow
}

function Get-BridgeHeaders {
  $headers = @{}
  if (-not [string]::IsNullOrWhiteSpace($BridgeToken)) {
    $headers['X-Codex-Bridge-Token'] = $BridgeToken
  }
  return $headers
}

function Add-OptionalStringArgument {
  param(
    [string[]]$Arguments,
    [string]$Name,
    [string]$Value
  )

  if ([string]::IsNullOrWhiteSpace($Value)) {
    return $Arguments
  }
  return @($Arguments + @($Name, $Value))
}

function Get-ConfigValue {
  param(
    [hashtable]$Config,
    [string]$Name,
    $Fallback
  )

  if ($Config.ContainsKey($Name) -and $null -ne $Config[$Name] -and "$($Config[$Name])".Trim().Length -gt 0) {
    return $Config[$Name]
  }
  return $Fallback
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

function Stop-ProcessTree {
  param(
    [int]$ProcessId,
    [object[]]$AllProcesses
  )

  $children = @($AllProcesses | Where-Object { $_.ParentProcessId -eq $ProcessId })
  foreach ($child in $children) {
    Stop-ProcessTree -ProcessId ([int]$child.ProcessId) -AllProcesses $AllProcesses
  }
  if ($ProcessId -ne $PID) {
    Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
  }
}

function Get-MatchingProcesses {
  param(
    [string]$Pattern,
    [switch]$RequireRepoPath
  )

  $escapedRepo = [Regex]::Escape($repoRoot)
  return @(Get-CimInstance Win32_Process | Where-Object {
    $commandLine = [string]$_.CommandLine
    if ($_.ProcessId -eq $PID -or [string]::IsNullOrWhiteSpace($commandLine)) {
      $false
    } elseif ($RequireRepoPath -and $commandLine -notmatch $escapedRepo) {
      $false
    } else {
      $commandLine -match $Pattern
    }
  })
}

function Test-ProjectProcess {
  param([string]$Pattern)

  return (@(Get-MatchingProcesses -Pattern $Pattern -RequireRepoPath).Count -gt 0)
}

function Stop-MatchingProcessTree {
  param(
    [string]$Pattern,
    [switch]$RequireRepoPath
  )

  $allProcesses = @(Get-CimInstance Win32_Process)
  $targets = @(Get-MatchingProcesses -Pattern $Pattern -RequireRepoPath:$RequireRepoPath)
  foreach ($target in $targets) {
    Write-Info "停止旧进程树 PID=$($target.ProcessId): $Pattern"
    Stop-ProcessTree -ProcessId ([int]$target.ProcessId) -AllProcesses $allProcesses
  }
}

function Stop-StaleLauncherWindows {
  Write-Step "整理一键启动窗口"
  $allProcesses = @(Get-CimInstance Win32_Process)
  $protectedProcessIds = [System.Collections.Generic.HashSet[int]]::new()
  $currentId = [int]$PID
  while ($currentId -gt 0 -and $protectedProcessIds.Add($currentId)) {
    $current = $allProcesses | Where-Object { [int]$_.ProcessId -eq $currentId } | Select-Object -First 1
    if ($null -eq $current -or $null -eq $current.ParentProcessId) {
      break
    }
    $currentId = [int]$current.ParentProcessId
  }

  $launchers = @(Get-MatchingProcesses -Pattern 'start-codex-mobile-stack\.ps1' -RequireRepoPath | Where-Object {
    -not $protectedProcessIds.Contains([int]$_.ProcessId)
  })
  if ($launchers.Count -eq 0) {
    Write-Info "没有旧的一键启动窗口"
    return
  }
  foreach ($launcher in $launchers) {
    Write-Info "关闭旧的一键启动窗口 PID=$($launcher.ProcessId)"
    Stop-Process -Id ([int]$launcher.ProcessId) -Force -ErrorAction SilentlyContinue
  }
}

function Stop-ProjectProcess {
  param([string]$Pattern)

  Stop-MatchingProcessTree -Pattern $Pattern -RequireRepoPath
}

function Stop-BridgePortOwner {
  param([int]$Port)

  $owners = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess -Unique |
    Where-Object { $_ -and $_ -ne $PID })
  if ($owners.Count -eq 0) {
    return
  }

  $allProcesses = @(Get-CimInstance Win32_Process)
  foreach ($owner in $owners) {
    $processInfo = $allProcesses | Where-Object { [int]$_.ProcessId -eq [int]$owner } | Select-Object -First 1
    $commandLine = [string]$processInfo.CommandLine
    if ($commandLine -notmatch 'src[\\/]server\.js') {
      Write-Warn "端口 $Port 被非 bridge 进程占用，未自动停止 PID=$owner"
      continue
    }
    Write-Info "释放本地 bridge 端口 $Port PID=$owner"
    Stop-ProcessTree -ProcessId ([int]$owner) -AllProcesses $allProcesses
  }
}

function Test-LocalAddressMatch {
  param(
    [string]$ActualAddress,
    [string]$ExpectedAddress
  )

  if ($ActualAddress -eq $ExpectedAddress -or $ActualAddress -eq '0.0.0.0' -or $ActualAddress -eq '::') {
    return $true
  }
  if ($ExpectedAddress -eq '127.0.0.1' -and ($ActualAddress -eq 'localhost' -or $ActualAddress -eq '::1')) {
    return $true
  }
  return $false
}

function Test-LocalPortListening {
  param(
    [string]$HostAddress,
    [int]$Port
  )

  $listeners = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
  foreach ($listener in $listeners) {
    if (Test-LocalAddressMatch -ActualAddress ([string]$listener.LocalAddress) -ExpectedAddress $HostAddress) {
      return $true
    }
  }
  return $false
}

function Get-LocalPortOwnerIds {
  param(
    [string]$HostAddress,
    [int]$Port
  )

  $owners = @()
  $listeners = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
  foreach ($listener in $listeners) {
    if (Test-LocalAddressMatch -ActualAddress ([string]$listener.LocalAddress) -ExpectedAddress $HostAddress) {
      $owners += [int]$listener.OwningProcess
    }
  }
  return @($owners | Where-Object { $_ -and $_ -ne $PID } | Select-Object -Unique)
}

function Get-RepoAncestorProcessId {
  param(
    [int]$ProcessId,
    [object[]]$AllProcesses
  )

  $escapedRepo = [Regex]::Escape($repoRoot)
  $seen = @{}
  $currentId = $ProcessId
  while ($currentId -gt 0 -and -not $seen.ContainsKey("$currentId")) {
    $seen["$currentId"] = $true
    $process = $AllProcesses | Where-Object { [int]$_.ProcessId -eq [int]$currentId } | Select-Object -First 1
    if ($null -eq $process) {
      return 0
    }

    $commandLine = [string]$process.CommandLine
    if (-not [string]::IsNullOrWhiteSpace($commandLine) -and $commandLine -match $escapedRepo) {
      return [int]$process.ProcessId
    }

    $parentId = [int]$process.ParentProcessId
    if ($parentId -eq $currentId) {
      return 0
    }
    $currentId = $parentId
  }
  return 0
}

function Get-LocalBridgeHealth {
  Invoke-JsonSafe -Uri "$BridgeUrl/health" -Headers (Get-BridgeHeaders) -TimeoutSec 4
}

function Wait-BridgeHealth {
  param([int]$TimeoutSeconds = 25)

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  $lastError = ''
  while ((Get-Date) -lt $deadline) {
    $probe = Get-LocalBridgeHealth
    if ($probe.Ok) {
      return $probe.Value
    }
    $lastError = $probe.Error
    Start-Sleep -Milliseconds 700
  }
  throw "Bridge 健康检查失败: $BridgeUrl/health; $lastError"
}

function Start-LocalBridgeProcess {
  $stdout = Join-Path $logRoot 'bridge.stdout.log'
  $stderr = Join-Path $logRoot 'bridge.stderr.log'
  $command = @"
`$env:CODEX_BRIDGE_HOST='0.0.0.0'
`$env:CODEX_BRIDGE_PORT='$BridgePort'
`$env:CODEX_BRIDGE_WORKSPACE='$repoRoot'
`$env:CODEX_BRIDGE_TOKEN='$BridgeToken'
`$env:CODEX_BRIDGE_ADAPTER='codex'
node src/server.js
"@
  Start-Process -WindowStyle Hidden -FilePath 'powershell.exe' -ArgumentList @(
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-Command', $command
  ) -WorkingDirectory $repoRoot -RedirectStandardOutput $stdout -RedirectStandardError $stderr | Out-Null
}

function Ensure-LocalBridge {
  Write-Step "检查本地 Codex bridge"
  if (-not $ForceRestart) {
    $probe = Get-LocalBridgeHealth
    if ($probe.Ok) {
      $run = Get-ObjectValue -Object $probe.Value -Name 'run' -Fallback $null
      $runId = Get-ObjectValue -Object $run -Name 'runId' -Fallback 'unknown'
      Write-Info "已在线: $BridgeUrl run=$runId"
      return
    }
    Write-Warn "未在线，将启动: $($probe.Error)"
  } else {
    Write-Warn "已指定 -ForceRestart，将重启本地 bridge"
  }

  Stop-ProjectProcess -Pattern 'src[\\/]server\.js'
  Stop-BridgePortOwner -Port $BridgePort
  Start-Sleep -Milliseconds 500
  Start-LocalBridgeProcess
  $health = Wait-BridgeHealth -TimeoutSeconds 25
  $run = Get-ObjectValue -Object $health -Name 'run' -Fallback $null
  $runId = Get-ObjectValue -Object $run -Name 'runId' -Fallback 'unknown'
  Write-Info "Bridge 已就绪: $BridgeUrl run=$runId"
}

function Ensure-BackgroundScript {
  param(
    [string]$DisplayName,
    [string]$Pattern,
    [string]$ScriptPath,
    [string[]]$Arguments,
    [string]$StdoutName,
    [string]$StderrName
  )

  if ($ForceRestart) {
    Stop-ProjectProcess -Pattern $Pattern
  }
  if (Test-ProjectProcess -Pattern $Pattern) {
    Write-Info "$DisplayName 已运行"
    return
  }

  $stdout = Join-Path $logRoot $StdoutName
  $stderr = Join-Path $logRoot $StderrName
  $argumentList = @(
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', $ScriptPath
  ) + $Arguments
  Start-Process -WindowStyle Hidden -FilePath 'powershell.exe' -ArgumentList $argumentList -WorkingDirectory $repoRoot -RedirectStandardOutput $stdout -RedirectStandardError $stderr | Out-Null
  Write-Info "$DisplayName 已启动"
}

function Ensure-LocalBridgeWatchdog {
  Write-Step "检查本地 bridge 自动恢复"
  Ensure-BackgroundScript `
    -DisplayName '本地 bridge watchdog' `
    -Pattern 'watch-local-bridge\.ps1' `
    -ScriptPath (Join-Path $repoRoot 'tools\harmony\watch-local-bridge.ps1') `
    -Arguments (Add-OptionalStringArgument -Arguments @('-BridgePort', "$BridgePort") -Name '-BridgeToken' -Value $BridgeToken) `
    -StdoutName 'local-bridge-watchdog.stdout.log' `
    -StderrName 'local-bridge-watchdog.stderr.log'
}

function Start-RelayProcess {
  param(
    [string]$Mode,
    [string]$Name
  )

  $stdout = Join-Path $logRoot "$Name.stdout.log"
  $stderr = Join-Path $logRoot "$Name.stderr.log"
  $script = Join-Path $repoRoot 'tools\harmony\start-hdc-relay.ps1'
  Start-Process -WindowStyle Hidden -FilePath 'powershell.exe' -ArgumentList @(
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', $script,
    '-Mode', $Mode,
    '-ConfigPath', $ConfigPath
  ) -WorkingDirectory $repoRoot -RedirectStandardOutput $stdout -RedirectStandardError $stderr | Out-Null
}

function Stop-BridgeProxyProcesses {
  Stop-ProjectProcess -Pattern 'start-hdc-relay\.ps1.*\bBridgeProxy\b'
  Stop-ProjectProcess -Pattern 'bridge:relay-proxy|start-bridge-proxy\.mjs'
}

function Stop-HdcProxyProcesses {
  Stop-ProjectProcess -Pattern 'start-hdc-relay\.ps1.*\bProxy\b'
  Stop-ProjectProcess -Pattern 'hdc:proxy|start-local-proxy\.mjs|HDC_PROXY_PORT'
}

function Stop-RelayProcesses {
  param([hashtable]$Config)

  Stop-ProjectProcess -Pattern 'watch-hdc-connection\.ps1'
  Stop-ProjectProcess -Pattern 'watch-bridge-proxy\.ps1'
  Stop-BridgeProxyProcesses
  Stop-HdcProxyProcesses

  $proxyHost = [string](Get-ConfigValue -Config $Config -Name 'ProxyHost' -Fallback '127.0.0.1')
  $proxyPort = [int](Get-ConfigValue -Config $Config -Name 'ProxyPort' -Fallback 11078)
  $allProcesses = @(Get-CimInstance Win32_Process)
  foreach ($owner in (Get-LocalPortOwnerIds -HostAddress $proxyHost -Port $proxyPort)) {
    $repoAncestorId = Get-RepoAncestorProcessId -ProcessId ([int]$owner) -AllProcesses $allProcesses
    if ($repoAncestorId -gt 0) {
      Write-Info "释放本项目 HDC proxy 端口 ${proxyHost}:$proxyPort PID=$owner"
      Stop-ProcessTree -ProcessId $repoAncestorId -AllProcesses $allProcesses
    } else {
      Write-Info "HDC proxy 由外部工具接管，保持运行: ${proxyHost}:$proxyPort PID=$owner"
    }
  }
}

function Get-RelayStateSafe {
  param([hashtable]$Config)

  $relayHost = [string](Get-ConfigValue -Config $Config -Name 'RelayHost' -Fallback '<your-relay-server>')
  $relayPort = [int](Get-ConfigValue -Config $Config -Name 'RelayPort' -Fallback 19078)
  $relayToken = [string](Get-ConfigValue -Config $Config -Name 'Token' -Fallback '')
  $url = "http://${relayHost}:${relayPort}/__relay/state?token=$([uri]::EscapeDataString($relayToken))"
  Invoke-JsonSafe -Uri $url -TimeoutSec 5
}

function Ensure-BridgeProxy {
  param([hashtable]$Config)

  Write-Step "检查公网 bridge 代理"
  $stateProbe = Get-RelayStateSafe -Config $Config
  $bridgePc = 0
  if ($stateProbe.Ok) {
    $bridgePc = [int](Get-ObjectValue -Object $stateProbe.Value.state -Name 'bridgePc' -Fallback 0)
  }

  if (-not $ForceRestart -and $stateProbe.Ok -and $bridgePc -gt 0) {
    Write-Info "公网 bridge 代理已在线: bridgePc=$bridgePc"
  } else {
    if (-not $stateProbe.Ok) {
      Write-Warn "公网 relay 状态暂不可读，将尝试补齐 bridge 代理: $($stateProbe.Error)"
    } elseif ($ForceRestart) {
      Write-Warn "已指定 -ForceRestart，将重启 bridge 代理"
    } else {
      Write-Warn "公网 bridge 代理池为空，将启动 bridge 代理"
    }
    Stop-BridgeProxyProcesses
    Start-Sleep -Milliseconds 500
    Start-RelayProcess -Mode 'BridgeProxy' -Name 'bridge-proxy'
    Start-Sleep -Seconds 2

    $after = Get-RelayStateSafe -Config $Config
    if ($after.Ok) {
      $afterBridgePc = [int](Get-ObjectValue -Object $after.Value.state -Name 'bridgePc' -Fallback 0)
      Write-Info "公网 bridge 状态: bridgePc=$afterBridgePc"
    } else {
      Write-Warn "bridge 代理已启动，但公网状态仍不可读: $($after.Error)"
    }
  }

  Ensure-BackgroundScript `
    -DisplayName '公网 bridge watchdog' `
    -Pattern 'watch-bridge-proxy\.ps1' `
    -ScriptPath (Join-Path $repoRoot 'tools\harmony\watch-bridge-proxy.ps1') `
    -Arguments @('-ConfigPath', $ConfigPath) `
    -StdoutName 'bridge-proxy-watchdog.stdout.log' `
    -StderrName 'bridge-proxy-watchdog.stderr.log'
}

function Ensure-LocalHdcProxy {
  param([hashtable]$Config)

  Write-Step "检查本地 HDC proxy"
  $proxyHost = [string](Get-ConfigValue -Config $Config -Name 'ProxyHost' -Fallback '127.0.0.1')
  $proxyPort = [int](Get-ConfigValue -Config $Config -Name 'ProxyPort' -Fallback 11078)
  $owners = @(Get-LocalPortOwnerIds -HostAddress $proxyHost -Port $proxyPort)

  if ($owners.Count -gt 0) {
    if ($ForceRestart) {
      $allProcesses = @(Get-CimInstance Win32_Process)
      $hasProjectOwner = $false
      foreach ($owner in $owners) {
        if ((Get-RepoAncestorProcessId -ProcessId ([int]$owner) -AllProcesses $allProcesses) -gt 0) {
          $hasProjectOwner = $true
        }
      }
      if (-not $hasProjectOwner) {
        Write-Info "HDC proxy 已由共享工具监听，复用: ${proxyHost}:$proxyPort PID=$($owners -join ',')"
        return
      }
    } else {
      Write-Info "HDC proxy 已监听: ${proxyHost}:$proxyPort PID=$($owners -join ',')"
      return
    }
  } else {
    Write-Warn "HDC proxy 未监听，将启动: ${proxyHost}:$proxyPort"
  }

  if ($ForceRestart) {
    Write-Warn "已指定 -ForceRestart，将重启本项目本地 HDC proxy"
  }
  Stop-HdcProxyProcesses
  Start-Sleep -Milliseconds 500
  Start-RelayProcess -Mode 'Proxy' -Name 'local-proxy'

  $deadline = (Get-Date).AddSeconds(12)
  while ((Get-Date) -lt $deadline -and -not (Test-LocalPortListening -HostAddress $proxyHost -Port $proxyPort)) {
    Start-Sleep -Milliseconds 500
  }
  if (-not (Test-LocalPortListening -HostAddress $proxyHost -Port $proxyPort)) {
    throw "本地 HDC proxy 未监听: ${proxyHost}:$proxyPort"
  }
  Write-Info "HDC proxy 已监听: ${proxyHost}:$proxyPort"
}

function Test-HdcTargetConnected {
  param(
    [string]$HdcPath,
    [string]$Target
  )

  if (-not (Test-Path -LiteralPath $HdcPath)) {
    return $false
  }
  $targets = @(& $HdcPath list targets -v 2>&1)
  foreach ($line in $targets) {
    if ($line -match [regex]::Escape($Target) -and $line -match '\bConnected\b') {
      return $true
    }
  }
  return $false
}

function Test-HdcTargetShellReady {
  param(
    [string]$HdcPath,
    [string]$Target
  )

  if (-not (Test-HdcTargetConnected -HdcPath $HdcPath -Target $Target)) {
    return $false
  }
  $probe = @(& $HdcPath -t $Target shell echo codex-link-ok 2>&1)
  return ($LASTEXITCODE -eq 0 -and (($probe -join "`n") -match 'codex-link-ok'))
}

function Ensure-HdcConnection {
  param([hashtable]$Config)

  Write-Step "检查 HDC 目标连接"
  $proxyHost = [string](Get-ConfigValue -Config $Config -Name 'ProxyHost' -Fallback '127.0.0.1')
  $proxyPort = [int](Get-ConfigValue -Config $Config -Name 'ProxyPort' -Fallback 11078)
  $hdcPath = [string](Get-ConfigValue -Config $Config -Name 'HdcPath' -Fallback 'C:\openHarmony\20\toolchains\hdc.exe')
  $target = "${proxyHost}:$proxyPort"

  if (-not (Test-Path -LiteralPath $hdcPath)) {
    Write-Warn "HDC 不存在，跳过 tconn: $hdcPath"
    return
  }

  if (-not $ForceRestart -and (Test-HdcTargetShellReady -HdcPath $hdcPath -Target $target)) {
    Write-Info "HDC target 已连接且 shell 可用: $target"
  } else {
    if (Test-HdcTargetConnected -HdcPath $hdcPath -Target $target) {
      Write-Warn "HDC target 列表显示已连接，但 shell 未确认；将重新 tconn: $target"
      & $hdcPath kill -r 2>&1 | Out-Null
      Start-Sleep -Milliseconds 700
    }
    Write-Info "执行 hdc tconn $target"
    $output = @(& $hdcPath tconn $target 2>&1)
    $output | Out-Host
    if ($LASTEXITCODE -ne 0) {
      Write-Warn "HDC tconn 返回码 $LASTEXITCODE；watchdog 会继续重试。"
      $global:LASTEXITCODE = 0
    }
    if (Test-HdcTargetShellReady -HdcPath $hdcPath -Target $target) {
      Write-Info "HDC target 已连接且 shell 可用: $target"
    } else {
      Write-Warn "HDC target 暂未真正可用，将重启本项目本地 proxy 后再试一次。"
      $owners = @(Get-LocalPortOwnerIds -HostAddress $proxyHost -Port $proxyPort)
      $allProcesses = @(Get-CimInstance Win32_Process)
      $canRestartLocalProxy = ($owners.Count -eq 0)
      foreach ($owner in $owners) {
        if ((Get-RepoAncestorProcessId -ProcessId ([int]$owner) -AllProcesses $allProcesses) -gt 0) {
          $canRestartLocalProxy = $true
        }
      }
      if ($canRestartLocalProxy) {
        Stop-HdcProxyProcesses
      } else {
        Write-Warn "当前 HDC proxy 由共享工具接管，不在本脚本里强杀；watchdog 会继续自动恢复。"
      }
      Start-Sleep -Milliseconds 700
      if ($canRestartLocalProxy) {
        Start-RelayProcess -Mode 'Proxy' -Name 'local-proxy'
      }

      $deadline = (Get-Date).AddSeconds(12)
      while ((Get-Date) -lt $deadline -and -not (Test-LocalPortListening -HostAddress $proxyHost -Port $proxyPort)) {
        Start-Sleep -Milliseconds 500
      }
      if (Test-LocalPortListening -HostAddress $proxyHost -Port $proxyPort) {
        $retryOutput = @(& $hdcPath tconn $target 2>&1)
        $retryOutput | Out-Host
        $global:LASTEXITCODE = 0
      }

      if (Test-HdcTargetShellReady -HdcPath $hdcPath -Target $target) {
        Write-Info "HDC target 已恢复且 shell 可用: $target"
      } else {
        Write-Warn "HDC target 仍未连接，已保留自动重连 watchdog。"
      }
    }
  }

  & $hdcPath list targets | Out-Host
  $global:LASTEXITCODE = 0
}

function Get-ConfigPathFromCommandLine {
  param([string]$CommandLine)

  if ($CommandLine -match '(?i)-ConfigPath\s+(?:"(?<quoted>[^"]+)"|(?<plain>\S+))') {
    if ($Matches['quoted']) {
      return [string]$Matches['quoted']
    }
    return [string]$Matches['plain']
  }
  return ''
}

function Test-RelayConfigEquivalent {
  param(
    [string]$DesiredConfigPath,
    [string]$CandidateConfigPath
  )

  try {
    if ([string]::IsNullOrWhiteSpace($CandidateConfigPath) -or -not (Test-Path -LiteralPath $CandidateConfigPath)) {
      return $false
    }
    $desired = Import-PowerShellDataFile -LiteralPath $DesiredConfigPath
    $candidate = Import-PowerShellDataFile -LiteralPath $CandidateConfigPath
    foreach ($key in @('RelayHost', 'RelayPort', 'Token', 'DeviceId', 'ProxyHost', 'ProxyPort')) {
      $left = [string](Get-ConfigValue -Config $desired -Name $key -Fallback '')
      $right = [string](Get-ConfigValue -Config $candidate -Name $key -Fallback '')
      if ($left -ne $right) {
        return $false
      }
    }
    return $true
  } catch {
    return $false
  }
}

function Test-SharedHdcWatchdogRunning {
  $watchdogs = @(Get-CimInstance Win32_Process | Where-Object {
    $commandLine = [string]$_.CommandLine
    $_.ProcessId -ne $PID -and
    -not [string]::IsNullOrWhiteSpace($commandLine) -and
    $commandLine -match 'watch-hdc-connection\.ps1'
  })
  foreach ($watchdog in $watchdogs) {
    $commandLine = [string]$watchdog.CommandLine
    $candidateConfigPath = Get-ConfigPathFromCommandLine -CommandLine $commandLine
    if (Test-RelayConfigEquivalent -DesiredConfigPath $ConfigPath -CandidateConfigPath $candidateConfigPath) {
      Write-Info "复用共享 HDC watchdog PID=$($watchdog.ProcessId): $candidateConfigPath"
      return $true
    }
  }
  return $false
}

function Ensure-HdcWatchdog {
  if ($ForceRestart) {
    Stop-ProjectProcess -Pattern 'watch-hdc-connection\.ps1'
  }
  if (Test-SharedHdcWatchdogRunning) {
    return
  }
  Ensure-BackgroundScript `
    -DisplayName 'HDC 自动重连 watchdog' `
    -Pattern 'watch-hdc-connection\.ps1' `
    -ScriptPath (Join-Path $repoRoot 'tools\harmony\watch-hdc-connection.ps1') `
    -Arguments @('-ConfigPath', $ConfigPath) `
    -StdoutName 'hdc-watchdog.stdout.log' `
    -StderrName 'hdc-watchdog.stderr.log'
}

function Ensure-HdcRelay {
  if ($SkipHdcRelay) {
    return
  }
  if (-not (Test-Path -LiteralPath $ConfigPath)) {
    throw "缺少 HDC Relay 配置: $ConfigPath"
  }

  Write-Step "检查公网 bridge/HDC 代理"
  $config = Import-PowerShellDataFile -LiteralPath $ConfigPath
  if ($ForceRestart) {
    Stop-RelayProcesses -Config $config
    Start-Sleep -Milliseconds 600
  }

  Ensure-BridgeProxy -Config $config
  Ensure-LocalHdcProxy -Config $config
  Ensure-HdcWatchdog
  Ensure-HdcConnection -Config $config
}

function Show-RelayState {
  if ($SkipHdcRelay) {
    return
  }
  Write-Step "检查公网 bridge/HDC 状态"
  $script = Join-Path $repoRoot 'tools\harmony\check-relay-state.ps1'
  $args = @(
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', $script,
    '-ConfigPath', $ConfigPath,
    '-SkipDesktopScreenshot'
  )
  $args = Add-OptionalStringArgument -Arguments $args -Name '-BridgeToken' -Value $BridgeToken
  & powershell.exe @args
  if ($LASTEXITCODE -ne 0) {
    Write-Warn "Relay 状态检查失败，详见上方输出。"
    $global:LASTEXITCODE = 0
  }
}

function Get-DesktopLiveStatus {
  Invoke-JsonSafe -Uri "$BridgeUrl/desktop/script/status" -Headers (Get-BridgeHeaders) -TimeoutSec 6
}

function Test-DesktopLiveOnline {
  $status = Get-DesktopLiveStatus
  if (-not $status.Ok) {
    return $false
  }
  $bridge = Get-ObjectValue -Object $status.Value -Name 'bridge' -Fallback $null
  return ([bool](Get-ObjectValue -Object $bridge -Name 'online' -Fallback $false))
}

function Test-CdpReady {
  param([int]$Port = 9229)

  foreach ($path in @('/json', '/json/list')) {
    $probe = Invoke-JsonSafe -Uri "http://127.0.0.1:$Port$path" -TimeoutSec 2
    if (-not $probe.Ok) {
      continue
    }
    $targets = @($probe.Value)
    foreach ($target in $targets) {
      $type = Get-ObjectValue -Object $target -Name 'type' -Fallback ''
      $webSocketUrl = Get-ObjectValue -Object $target -Name 'webSocketDebuggerUrl' -Fallback ''
      if ($type -eq 'page' -and -not [string]::IsNullOrWhiteSpace([string]$webSocketUrl)) {
        return $true
      }
    }
  }
  return $false
}

function Test-CodexDesktopShellRunning {
  $processes = @(Get-CimInstance Win32_Process | Where-Object {
    $path = [string]$_.ExecutablePath
    $cmd = [string]$_.CommandLine
    $isDesktopShell = $path.EndsWith('\app\Codex.exe', [System.StringComparison]::OrdinalIgnoreCase) -or
      ($cmd -match '\\app\\Codex\.exe"?(?:\s|$)')
    $isChildProcess = $cmd -match '\s--type='
    $isDesktopShell -and -not $isChildProcess
  })
  return $processes.Count -gt 0
}

function Ensure-CodexDesktopLive {
  if ($SkipCodexDesktop) {
    return
  }

  Write-Step "检查 Codex 桌面实时通道"
  if (-not $ForceRestart -and (Test-DesktopLiveOnline)) {
    Write-Info "桌面实时通道已在线"
    return
  }

  $cdpReady = Test-CdpReady -Port 9229
  $codexDesktopRunning = Test-CodexDesktopShellRunning
  $useSoftRecover = (-not $ForceRestart) -and ($cdpReady -or $codexDesktopRunning)
  $script = if ($useSoftRecover) {
    Join-Path $repoRoot 'scripts\recover-codex-desktop-live-soft.ps1'
  } else {
    Join-Path $repoRoot 'scripts\restart-codex-desktop-live.ps1'
  }
  $args = @(
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', $script,
    '-BridgeUrl', $BridgeUrl
  )
  $args = Add-OptionalStringArgument -Arguments $args -Name '-BridgeToken' -Value $BridgeToken
  if (-not [string]::IsNullOrWhiteSpace($SessionId)) {
    $args += @('-SessionId', $SessionId)
  }

  if ($useSoftRecover) {
    if ($cdpReady) {
      Write-Info "CDP 已在线，将软恢复桌面实时通道，不重启 Codex"
    } else {
      Write-Warn "检测到 Codex 已运行但默认 CDP 不在线，将只软恢复；不会自动重启普通 Codex"
    }
  } elseif ($KeepExistingCodex) {
    Write-Info "按参数要求保留现有 Codex"
    $args += '-KeepExistingCodex'
  } elseif (-not $ForceRestart -and -not $codexDesktopRunning) {
    Write-Warn "未检测到正在运行的 Codex，将启动带 CDP 的 Codex 桌面"
  } else {
    Write-Warn "桌面实时通道缺失，将启动/重启 Codex 并注入 CDP"
  }

  & powershell.exe @args
  if ($LASTEXITCODE -ne 0) {
    if ($useSoftRecover) {
      throw "Codex 桌面 live 软恢复失败，退出码: $LASTEXITCODE。当前检测到 Codex 已运行但没有可用 CDP，本脚本不会偷偷重启它；请关闭普通 Codex 后重试，或确认后使用 -ForceRestart。"
    }
    throw "Codex 桌面启动/CDP 注入失败，退出码: $LASTEXITCODE"
  }
}

function Test-BridgeApi {
  Write-Step "验证手机会话 API"
  $headers = Get-BridgeHeaders
  $health = Wait-BridgeHealth -TimeoutSeconds 10
  $run = Get-ObjectValue -Object $health -Name 'run' -Fallback $null
  $runId = Get-ObjectValue -Object $run -Name 'runId' -Fallback 'unknown'
  Write-Info "Bridge health: run=$runId"

  $scriptStatus = Invoke-JsonSafe -Uri "$BridgeUrl/desktop/script/status" -Headers $headers -TimeoutSec 8
  if ($scriptStatus.Ok) {
    $bridge = Get-ObjectValue -Object $scriptStatus.Value -Name 'bridge' -Fallback $null
    $online = Get-ObjectValue -Object $bridge -Name 'online' -Fallback $false
    Write-Info "桌面实时通道: online=$online"
  } else {
    Write-Warn "桌面实时通道状态暂不可读: $($scriptStatus.Error)"
  }

  $threads = Invoke-JsonSafe -Uri "$BridgeUrl/api/codex/threads" -Headers $headers -TimeoutSec 12
  if ($threads.Ok) {
    $threadItems = Get-ObjectValue -Object $threads.Value -Name 'threads' -Fallback $null
    if ($null -eq $threadItems) {
      $threadItems = Get-ObjectValue -Object $threads.Value -Name 'items' -Fallback $threads.Value
    }
    Write-Info "会话 API 已响应: count=$(@($threadItems).Count)"
  } else {
    Write-Warn "会话 API 暂不可读: $($threads.Error)"
  }
}

Stop-StaleLauncherWindows
Ensure-LocalBridge
Ensure-LocalBridgeWatchdog
Ensure-HdcRelay
Show-RelayState
Ensure-CodexDesktopLive
Test-BridgeApi

Write-Step "一键状态补齐完成"
Write-Host "手机端 bridge: $BridgeUrl" -ForegroundColor Green
Write-Host "本地 bridge: $BridgeUrl" -ForegroundColor Green
Write-Host "日志目录: $logRoot" -ForegroundColor DarkGray
Write-Host "强制重建整条链路可追加参数: -ForceRestart" -ForegroundColor DarkGray
exit 0
