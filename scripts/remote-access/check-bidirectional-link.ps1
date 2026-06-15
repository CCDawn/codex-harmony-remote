[CmdletBinding()]
param(
  [string]$SshHost = '<relay-server>',
  [string]$MacUser = 'mac',
  [int]$ServerWindowsRdpPort = 13389,
  [int]$ServerMacSshPort = 22022,
  [int]$LocalMacSshPort = 22222,
  [int]$MacLocalWindowsRdpPort = 3390
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

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

function Test-ServerPort {
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

$serverMacSsh = Test-ServerPort -Port $ServerMacSshPort
$serverWindowsRdp = Test-ServerPort -Port $ServerWindowsRdpPort
$localMacSsh = Test-TcpPort -HostName '127.0.0.1' -Port $LocalMacSshPort
$macLogin = $false
$macInfo = ''
$macLoginError = ''
$macLocalWindowsRdp = $false
if ($localMacSsh) {
  $macProbe = Invoke-Native -Command @($SshExe, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '-o', 'ConnectionAttempts=1', '-p', "$LocalMacSshPort", "$MacUser@127.0.0.1", "printf '%s@%s ' `$(whoami) `$(hostname); sw_vers -productVersion")
  $macInfo = $macProbe.Output
  $macLogin = ($macProbe.ExitCode -eq 0)
  if ($macLogin) {
    $rdpProbe = Invoke-Native -Command @($SshExe, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '-o', 'ConnectionAttempts=1', '-p', "$LocalMacSshPort", "$MacUser@127.0.0.1", "nc -z 127.0.0.1 $MacLocalWindowsRdpPort >/dev/null 2>&1 && echo ok || echo failed")
    $macLocalWindowsRdp = ($rdpProbe.ExitCode -eq 0 -and $rdpProbe.Output -match '^ok$')
  } else {
    $macLoginError = $macProbe.Output.Trim()
  }
}

$watchdogProcess = @(Get-CimInstance Win32_Process | Where-Object {
  [string]$_.CommandLine -match 'start-bidirectional-link-watchdog\.ps1'
})
$rdpReverseProcess = @(Get-CimInstance Win32_Process | Where-Object {
  [string]$_.CommandLine -match "127\.0\.0\.1:$ServerWindowsRdpPort"
})
$macForwardProcess = @(Get-CimInstance Win32_Process | Where-Object {
  [string]$_.CommandLine -match "127\.0\.0\.1:${LocalMacSshPort}:127\.0\.0\.1:${ServerMacSshPort}"
})

[pscustomobject]@{
  ServerMacSsh22022 = $serverMacSsh
  LocalMacSsh22222 = $localMacSsh
  MacLogin = $macLogin
  MacInfo = $macInfo.Trim()
  MacLoginError = $macLoginError
  MacLocalWindowsRdp3390 = $macLocalWindowsRdp
  ServerWindowsRdp13389 = $serverWindowsRdp
  WindowsWatchdogRunning = $watchdogProcess.Count -gt 0
  WindowsRdpReverseProcess = $rdpReverseProcess.Count
  WindowsMacForwardProcess = $macForwardProcess.Count
} | Format-List
