[CmdletBinding()]
param(
  [string]$SshHost = '<relay-server>',
  [int]$ServerMacSshPort = 22022,
  [int]$LocalPort = 22222,
  [string]$MacUser = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Test-TcpPort {
  param(
    [string]$HostName,
    [int]$Port
  )
  $client = [System.Net.Sockets.TcpClient]::new()
  try {
    $task = $client.ConnectAsync($HostName, $Port)
    if (-not $task.Wait(2000)) {
      return $false
    }
    return $client.Connected
  } catch {
    return $false
  } finally {
    $client.Dispose()
  }
}

$serverProbe = & ssh $SshHost "python3 - <<'PY'
import socket
s=socket.socket()
s.settimeout(2)
try:
    s.connect(('127.0.0.1',$ServerMacSshPort))
    print('ok')
except Exception as e:
    print('failed', repr(e))
finally:
    s.close()
PY" 2>&1

if ($serverProbe -notmatch '^ok$') {
  throw "Server-side Mac SSH reverse tunnel is not reachable: ${SshHost}:127.0.0.1:${ServerMacSshPort}. Output: $serverProbe"
}

if (Test-TcpPort -HostName '127.0.0.1' -Port $LocalPort) {
  Write-Host "Local Mac SSH forward already appears alive: 127.0.0.1:$LocalPort" -ForegroundColor Green
} else {
  $args = @(
    '-N',
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=3',
    '-L', "127.0.0.1:${LocalPort}:127.0.0.1:${ServerMacSshPort}",
    $SshHost
  )
  Write-Host "Starting local Mac SSH forward: 127.0.0.1:${LocalPort} -> ${SshHost}:127.0.0.1:${ServerMacSshPort}" -ForegroundColor Cyan
  Start-Process -WindowStyle Hidden -FilePath 'ssh.exe' -ArgumentList $args | Out-Null
  Start-Sleep -Seconds 1
  if (-not (Test-TcpPort -HostName '127.0.0.1' -Port $LocalPort)) {
    throw "Local forward did not start: 127.0.0.1:$LocalPort"
  }
}

Write-Host "Mac SSH tunnel ready." -ForegroundColor Green
if ([string]::IsNullOrWhiteSpace($MacUser)) {
  Write-Host "Connect with: ssh -p $LocalPort <mac-user>@127.0.0.1"
} else {
  Write-Host "Testing Mac SSH login for ${MacUser}@127.0.0.1:$LocalPort" -ForegroundColor Cyan
  & ssh -p $LocalPort "$MacUser@127.0.0.1" "uname -a; whoami; hostname"
}
