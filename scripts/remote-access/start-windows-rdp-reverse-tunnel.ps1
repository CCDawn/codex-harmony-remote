[CmdletBinding()]
param(
  [string]$SshHost = '<relay-server>',
  [int]$ServerListenPort = 13389,
  [string]$LocalRdpHost = '127.0.0.1',
  [int]$LocalRdpPort = 3389
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$listener = Get-NetTCPConnection -LocalPort $LocalRdpPort -State Listen -ErrorAction SilentlyContinue |
  Where-Object { $_.LocalAddress -eq $LocalRdpHost -or $_.LocalAddress -eq '0.0.0.0' -or $_.LocalAddress -eq '::' } |
  Select-Object -First 1
if (-not $listener) {
  throw "Local RDP is not listening on ${LocalRdpHost}:$LocalRdpPort. Enable RDP host first."
}

function Test-ServerForwardAlive {
  param(
    [string]$SshTarget,
    [int]$Port
  )
  try {
    $probe = @"
import socket
s=socket.socket()
s.settimeout(2)
try:
    s.connect(('127.0.0.1',$Port))
    print('connect-ok')
except Exception as e:
    print('connect-failed', e)
finally:
    s.close()
"@
    $result = & ssh $SshTarget "python3 - <<'PY'
$probe
PY" 2>&1
    return ($result -match 'connect-ok')
  } catch {
    return $false
  }
}

if (Test-ServerForwardAlive -SshTarget $SshHost -Port $ServerListenPort) {
  Write-Host "Reverse RDP tunnel already alive: ${SshHost}:127.0.0.1:${ServerListenPort}" -ForegroundColor Green
  exit 0
}

$args = @(
  '-N',
  '-o', 'ExitOnForwardFailure=yes',
  '-o', 'ServerAliveInterval=30',
  '-o', 'ServerAliveCountMax=3',
  '-R', "127.0.0.1:${ServerListenPort}:${LocalRdpHost}:${LocalRdpPort}",
  $SshHost
)

Write-Host "Starting reverse RDP tunnel: ${SshHost}:127.0.0.1:${ServerListenPort} -> ${LocalRdpHost}:$LocalRdpPort" -ForegroundColor Cyan
& ssh @args
