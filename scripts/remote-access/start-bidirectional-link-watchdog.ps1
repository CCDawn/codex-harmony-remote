[CmdletBinding()]
param(
  [string]$SshHost = '<relay-server>',
  [string]$MacUser = 'mac',
  [int]$ServerWindowsRdpPort = 13389,
  [int]$ServerMacSshPort = 22022,
  [int]$LocalMacSshPort = 22222,
  [int]$MacLocalWindowsRdpPort = 3390,
  [string]$LocalRdpHost = '127.0.0.1',
  [int]$LocalRdpPort = 3389,
  [int]$IntervalSeconds = 15
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$logDir = Join-Path $repoRoot 'logs\remote-access'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$logFile = Join-Path $logDir 'bidirectional-watchdog.log'

function Resolve-SshExe {
  $windowsRoot = if ($env:WINDIR) { $env:WINDIR } elseif ($env:SystemRoot) { $env:SystemRoot } else { 'C:\Windows' }
  $candidates = @(
    (Join-Path $windowsRoot 'System32\OpenSSH\ssh.exe'),
    (Join-Path $windowsRoot 'Sysnative\OpenSSH\ssh.exe'),
    'C:\Windows\System32\OpenSSH\ssh.exe',
    'C:\Windows\Sysnative\OpenSSH\ssh.exe'
  )
  foreach ($candidate in $candidates) {
    if (Test-Path -LiteralPath $candidate) {
      return $candidate
    }
  }
  $command = Get-Command ssh.exe -ErrorAction SilentlyContinue
  if ($command -and $command.Source) {
    return $command.Source
  }
  throw "OpenSSH client not found. Checked: $($candidates -join ', ')"
}

$SshExe = Resolve-SshExe

function Write-LinkLog {
  param([string]$Message)
  $line = "$(Get-Date -Format o) $Message"
  Add-Content -LiteralPath $logFile -Value $line -Encoding UTF8
  Write-Host $line
}

function Test-TcpPort {
  param([string]$HostName, [int]$Port)
  $client = [System.Net.Sockets.TcpClient]::new()
  try {
    $task = $client.ConnectAsync($HostName, $Port)
    if (-not $task.Wait(2000)) { return $false }
    return $client.Connected
  } catch {
    return $false
  } finally {
    $client.Dispose()
  }
}

function Invoke-Native {
  param([string[]]$Command)
  $oldErrorActionPreference = $ErrorActionPreference
  $global:ErrorActionPreference = 'Continue'
  try {
    $output = & $Command[0] @($Command | Select-Object -Skip 1) 2>&1
    return [pscustomobject]@{
      ExitCode = $LASTEXITCODE
      Output = (($output | ForEach-Object { "$_" }) -join "`n")
    }
  } finally {
    $global:ErrorActionPreference = $oldErrorActionPreference
  }
}

function Test-ServerLoopbackPort {
  param([int]$Port)
  $probe = Invoke-Native -Command @($SshExe, '-o', 'ConnectTimeout=5', $SshHost, "python3 - <<'PY'
import socket
s=socket.socket()
s.settimeout(2)
try:
    s.connect(('127.0.0.1',$Port))
    print('ok')
except Exception as e:
    print('failed', repr(e))
finally:
    s.close()
PY")
  return ($probe.ExitCode -eq 0 -and $probe.Output -match '^ok$')
}

function Test-LocalMacSshLogin {
  if (-not (Test-TcpPort -HostName '127.0.0.1' -Port $LocalMacSshPort)) {
    return $false
  }
  $probe = Invoke-Native -Command @(
    $SshExe,
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=5',
    '-o', 'ConnectionAttempts=1',
    '-p', "$LocalMacSshPort",
    "$MacUser@127.0.0.1",
    'echo ok'
  )
  if ($probe.ExitCode -eq 0 -and $probe.Output -match '^ok$') {
    return $true
  }
  Write-LinkLog "local Mac SSH forward is stale: $($probe.Output.Trim())"
  Clear-ServerLoopbackListener -Port $ServerMacSshPort
  return $false
}

function Invoke-MacCommand {
  param([string]$Command)
  Invoke-Native -Command @(
    $SshExe,
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=5',
    '-o', 'ConnectionAttempts=1',
    '-p', "$LocalMacSshPort",
    "$MacUser@127.0.0.1",
    $Command
  )
}

function Clear-ServerLoopbackListener {
  param([int]$Port)
  & $SshExe $SshHost "python3 - <<'PY'
import os, re, subprocess
port='$Port'
try:
    out=subprocess.check_output(['ss','-ltnp'], text=True, stderr=subprocess.DEVNULL)
except Exception:
    out=''
pids=set()
for line in out.splitlines():
    if f':{port} ' in line:
        pids.update(re.findall(r'pid=(\d+)', line))
for pid in pids:
    try:
        os.kill(int(pid), 15)
        print(f'killed pid={pid} port={port}')
    except Exception as exc:
        print(f'kill failed pid={pid} port={port}: {exc}')
PY" 2>&1 | ForEach-Object { Write-LinkLog "server: $_" }
}

function Get-ProjectSshProcesses {
  param([string]$Pattern)
  Get-CimInstance Win32_Process | Where-Object {
    $cmd = [string]$_.CommandLine
    $_.Name -ieq 'ssh.exe' -and $cmd -match $Pattern
  }
}

function Stop-LocalSshListeners {
  param([int]$Port, [string]$Label)
  $listeners = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
    Where-Object { $_.LocalAddress -eq '127.0.0.1' -or $_.LocalAddress -eq '0.0.0.0' -or $_.LocalAddress -eq '::' })
  $listenerProcessIds = @($listeners | Select-Object -ExpandProperty OwningProcess -Unique)
  foreach ($listenerProcessId in $listenerProcessIds) {
    $process = Get-Process -Id $listenerProcessId -ErrorAction SilentlyContinue
    if ($process -and $process.ProcessName -ieq 'ssh') {
      Write-LinkLog "stopping stale ${Label} listener pid=$listenerProcessId port=$Port"
      Stop-Process -Id $listenerProcessId -Force -ErrorAction SilentlyContinue
    }
  }
}

function Ensure-WindowsRdpReverse {
  $rdpListening = Get-NetTCPConnection -LocalPort $LocalRdpPort -State Listen -ErrorAction SilentlyContinue |
    Where-Object { $_.LocalAddress -eq $LocalRdpHost -or $_.LocalAddress -eq '0.0.0.0' -or $_.LocalAddress -eq '::' } |
    Select-Object -First 1
  if (-not $rdpListening) {
    Write-LinkLog "Windows RDP is not listening on ${LocalRdpHost}:$LocalRdpPort"
    return
  }
  if (Test-ServerLoopbackPort -Port $ServerWindowsRdpPort) {
    return
  }

  Clear-ServerLoopbackListener -Port $ServerWindowsRdpPort
  $pattern = "127\.0\.0\.1:$ServerWindowsRdpPort"
  Get-ProjectSshProcesses -Pattern $pattern | ForEach-Object {
    Write-LinkLog "stopping stale Windows RDP reverse ssh pid=$($_.ProcessId)"
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
  }
  $args = @(
    '-N',
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=20',
    '-o', 'ServerAliveCountMax=2',
    '-R', "127.0.0.1:${ServerWindowsRdpPort}:${LocalRdpHost}:${LocalRdpPort}",
    $SshHost
  )
  Write-LinkLog "starting Windows RDP reverse: server 127.0.0.1:${ServerWindowsRdpPort} -> ${LocalRdpHost}:$LocalRdpPort"
  Start-Process -WindowStyle Hidden -FilePath $SshExe -ArgumentList $args | Out-Null
}

function Ensure-MacSshLocalForward {
  if (-not (Test-ServerLoopbackPort -Port $ServerMacSshPort)) {
    Write-LinkLog "Mac reverse SSH server port is unavailable: 127.0.0.1:$ServerMacSshPort"
    return $false
  }
  if (Test-LocalMacSshLogin) {
    return $true
  }

  $pattern = "127\.0\.0\.1:$LocalMacSshPort:127\.0\.0\.1:$ServerMacSshPort"
  Get-ProjectSshProcesses -Pattern $pattern | ForEach-Object {
    Write-LinkLog "stopping stale local Mac SSH forward pid=$($_.ProcessId)"
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
  }
  Stop-LocalSshListeners -Port $LocalMacSshPort -Label 'local Mac SSH forward'
  Start-Sleep -Seconds 1
  $args = @(
    '-N',
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=20',
    '-o', 'ServerAliveCountMax=2',
    '-L', "127.0.0.1:${LocalMacSshPort}:127.0.0.1:${ServerMacSshPort}",
    $SshHost
  )
  Write-LinkLog "starting local Mac SSH forward: 127.0.0.1:${LocalMacSshPort} -> server 127.0.0.1:${ServerMacSshPort}"
  Start-Process -WindowStyle Hidden -FilePath $SshExe -ArgumentList $args | Out-Null
  Start-Sleep -Seconds 2
  return (Test-LocalMacSshLogin)
}

function Ensure-MacWindowsRdpForward {
  $probe = Invoke-MacCommand -Command "nc -z 127.0.0.1 $MacLocalWindowsRdpPort >/dev/null 2>&1 && echo ok || echo missing"
  if ($probe.ExitCode -eq 0 -and $probe.Output -match '^ok$') {
    return
  }

  Write-LinkLog "Mac local Windows RDP forward is unavailable: 127.0.0.1:$MacLocalWindowsRdpPort"
  $kick = Invoke-MacCommand -Command "uid=`$(id -u); launchctl kickstart -k gui/`$uid/com.codex.remote.mac-windows-rdp-forward >/dev/null 2>&1 || true; sleep 2; nc -z 127.0.0.1 $MacLocalWindowsRdpPort >/dev/null 2>&1 && echo ok || echo missing"
  if ($kick.ExitCode -eq 0 -and $kick.Output -match '^ok$') {
    Write-LinkLog "Mac local Windows RDP forward recovered: 127.0.0.1:$MacLocalWindowsRdpPort"
  } else {
    Write-LinkLog "Mac local Windows RDP forward is still unavailable after kick: $($kick.Output.Trim())"
  }
}

Write-LinkLog "bidirectional watchdog started"
while ($true) {
  try {
    Ensure-WindowsRdpReverse
    $macSshReady = Ensure-MacSshLocalForward
    if ($macSshReady) {
      Ensure-MacWindowsRdpForward
    }
  } catch {
    Write-LinkLog "watchdog error: $($_.Exception.Message)"
  }
  Start-Sleep -Seconds $IntervalSeconds
}
