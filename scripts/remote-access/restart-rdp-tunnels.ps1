[CmdletBinding()]
param(
  [string]$SshHost = '<relay-server>',
  [string]$MacUser = 'mac',
  [int]$MacLocalSshPort = 22222,
  [int]$ServerMacSshPort = 22022,
  [int]$ServerWindowsRdpPort = 13389,
  [int]$MacLocalWindowsRdpPort = 3390,
  [switch]$ClearMacReverseSsh,
  [switch]$SkipMacForwardRestart
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$checkScript = Join-Path $scriptRoot 'check-bidirectional-link.ps1'
$watchdogScript = Join-Path $scriptRoot 'start-bidirectional-link-watchdog.ps1'

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
Write-Host "Using SSH client: $SshExe" -ForegroundColor DarkGray

function Stop-MatchingProcess {
  param([string]$Pattern, [string]$Label)
  $processes = @(Get-CimInstance Win32_Process | Where-Object {
    $_.Name -ieq 'ssh.exe' -and [string]$_.CommandLine -match $Pattern
  })
  foreach ($process in $processes) {
    Write-Host "Stopping ${Label} PID=$($process.ProcessId)"
    Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
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
      Write-Host "Stopping stale ${Label} listener PID=$listenerProcessId port=$Port"
      Stop-Process -Id $listenerProcessId -Force -ErrorAction SilentlyContinue
    }
  }
}

function Invoke-Server {
  param([string]$Command)
  & $SshExe -o ConnectTimeout=8 $SshHost $Command
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

Write-Host 'Stopping stale Windows RDP reverse SSH processes...' -ForegroundColor Cyan
Stop-MatchingProcess -Pattern "127\.0\.0\.1:$ServerWindowsRdpPort:127\.0\.0\.1:3389" -Label 'Windows RDP reverse tunnel'
Stop-MatchingProcess -Pattern "127\.0\.0\.1:$MacLocalSshPort:127\.0\.0\.1:$ServerMacSshPort" -Label 'local Mac SSH forward'
Stop-LocalSshListeners -Port $MacLocalSshPort -Label 'local Mac SSH forward'

Write-Host 'Clearing server loopback RDP listeners if any stale process remains...' -ForegroundColor Cyan
Invoke-Server "python3 - <<'PY'
import os, re, subprocess, signal
port='$ServerWindowsRdpPort'
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
        os.kill(int(pid), signal.SIGTERM)
        print(f'killed pid={pid} port={port}')
    except Exception as exc:
        print(f'kill failed pid={pid} port={port}: {exc}')
PY" | ForEach-Object { if ($_ -and $_.Trim()) { Write-Host "server: $_" } }

if ($ClearMacReverseSsh) {
  Write-Host 'Clearing server Mac SSH reverse listener because -ClearMacReverseSsh was requested...' -ForegroundColor Cyan
  Invoke-Server "python3 - <<'PY'
import os, re, subprocess, signal
port='$ServerMacSshPort'
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
        os.kill(int(pid), signal.SIGTERM)
        print(f'killed pid={pid} port={port}')
    except Exception as exc:
        print(f'kill failed pid={pid} port={port}: {exc}')
PY" | ForEach-Object { if ($_ -and $_.Trim()) { Write-Host "server: $_" } }
} else {
  Write-Host 'Keeping server Mac SSH reverse listener online; pass -ClearMacReverseSsh only when 22022 is wedged.' -ForegroundColor DarkGray
}

Write-Host 'Waiting for watchdog to recreate Windows RDP reverse tunnel...' -ForegroundColor Cyan
$watchdog = @(Get-CimInstance Win32_Process | Where-Object {
  [string]$_.CommandLine -match 'start-bidirectional-link-watchdog\.ps1'
})
if ($watchdog.Count -eq 0) {
  Write-Host 'Starting bidirectional watchdog...' -ForegroundColor Cyan
  Start-Process -WindowStyle Hidden -FilePath powershell.exe -ArgumentList @(
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    $watchdogScript
  ) | Out-Null
}
Start-Sleep -Seconds 6

if (-not $SkipMacForwardRestart) {
  Write-Host 'Restarting Mac local RDP forward LaunchAgent after Windows RDP reverse is back...' -ForegroundColor Cyan
  for ($attempt = 1; $attempt -le 6; $attempt += 1) {
    $macCmd = @"
uid=`$(id -u)
launchctl kickstart -k gui/`$uid/com.codex.remote.mac-windows-rdp-forward >/dev/null 2>&1 || true
sleep 2
nc -z 127.0.0.1 $MacLocalWindowsRdpPort >/dev/null 2>&1 && echo mac-rdp-forward-ok || echo mac-rdp-forward-not-ready
"@
    $macProbe = Invoke-Native -Command @($SshExe, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'ConnectionAttempts=1', '-p', "$MacLocalSshPort", "$MacUser@127.0.0.1", $macCmd)
    if ($macProbe.Output.Trim()) {
      $macProbe.Output -split "`n" | ForEach-Object {
        if ($_ -and $_.Trim()) { Write-Host "mac: $_" }
      }
    }
    if ($macProbe.ExitCode -eq 0 -and $macProbe.Output -match 'mac-rdp-forward-ok') {
      break
    }
    if ($attempt -lt 6) {
      Start-Sleep -Seconds 3
    }
  }
}

if (Test-Path -LiteralPath $checkScript) {
  & powershell -NoProfile -ExecutionPolicy Bypass -File $checkScript
} else {
  Write-Host "Missing health check script: $checkScript" -ForegroundColor Yellow
}
