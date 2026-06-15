[CmdletBinding()]
param(
  [string]$MacUser = 'mac',
  [int]$MacLocalSshPort = 22222,
  [string]$ServerSshHost = '<relay-server>',
  [string]$ServerPublicHost = 'root@<your-relay-server>',
  [int]$ServerMacSshPort = 22022,
  [int]$ServerMacVncPort = 15900,
  [switch]$EnableVnc
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$watchdogLocal = Join-Path $scriptRoot 'mac-reverse-access-watchdog.sh'
if (-not (Test-Path -LiteralPath $watchdogLocal)) {
  throw "Missing watchdog script: $watchdogLocal"
}

function Invoke-Mac {
  param([string]$Command)
  & ssh -p $MacLocalSshPort "$MacUser@127.0.0.1" $Command
}

function Invoke-Server {
  param([string]$Command)
  & ssh $ServerSshHost $Command
}

Write-Host "Preparing Mac SSH key..." -ForegroundColor Cyan
Invoke-Mac "mkdir -p ~/.ssh ~/codex-remote-link ~/codex-remote-link/logs ~/Library/LaunchAgents; chmod 700 ~/.ssh; test -f ~/.ssh/id_ed25519 || ssh-keygen -t ed25519 -N '' -f ~/.ssh/id_ed25519 -C mac-codex-reverse"
$macPublicKey = (& ssh -p $MacLocalSshPort "$MacUser@127.0.0.1" "cat ~/.ssh/id_ed25519.pub").Trim()
if ([string]::IsNullOrWhiteSpace($macPublicKey)) {
  throw 'Mac public key is empty.'
}

Write-Host "Authorizing Mac key on relay server..." -ForegroundColor Cyan
$tmpKey = Join-Path $env:TEMP 'mac-codex-reverse.pub'
$macPublicKey | Set-Content -LiteralPath $tmpKey -Encoding ascii
& scp $tmpKey "${ServerSshHost}:/tmp/mac-codex-reverse.pub"
Remove-Item -LiteralPath $tmpKey -Force -ErrorAction SilentlyContinue
Invoke-Server 'mkdir -p ~/.ssh; chmod 700 ~/.ssh; touch ~/.ssh/authorized_keys; grep -qxF -f /tmp/mac-codex-reverse.pub ~/.ssh/authorized_keys || cat /tmp/mac-codex-reverse.pub >> ~/.ssh/authorized_keys; chmod 600 ~/.ssh/authorized_keys; rm -f /tmp/mac-codex-reverse.pub'

Write-Host "Uploading Mac watchdog..." -ForegroundColor Cyan
& scp -P $MacLocalSshPort $watchdogLocal "${MacUser}@127.0.0.1:~/codex-remote-link/mac-reverse-access-watchdog.sh"
Invoke-Mac "chmod +x ~/codex-remote-link/mac-reverse-access-watchdog.sh"

$enableVncValue = if ($EnableVnc) { '1' } else { '0' }
$plist = @"
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.codex.remote.mac-reverse-access</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>/Users/$MacUser/codex-remote-link/mac-reverse-access-watchdog.sh</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>SSH_HOST</key>
    <string>$ServerPublicHost</string>
    <key>SERVER_SSH_PORT</key>
    <string>$ServerMacSshPort</string>
    <key>SERVER_VNC_PORT</key>
    <string>$ServerMacVncPort</string>
    <key>ENABLE_VNC</key>
    <string>$enableVncValue</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>NetworkState</key>
    <true/>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>/Users/$MacUser/codex-remote-link/logs/launchagent.out.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/$MacUser/codex-remote-link/logs/launchagent.err.log</string>
</dict>
</plist>
"@
$tmpPlist = Join-Path $env:TEMP 'com.codex.remote.mac-reverse-access.plist'
$plist | Set-Content -LiteralPath $tmpPlist -Encoding UTF8
& scp -P $MacLocalSshPort $tmpPlist "${MacUser}@127.0.0.1:~/Library/LaunchAgents/com.codex.remote.mac-reverse-access.plist"
Remove-Item -LiteralPath $tmpPlist -Force -ErrorAction SilentlyContinue

Write-Host "Loading LaunchAgent..." -ForegroundColor Cyan
$macUid = (& ssh -p $MacLocalSshPort "$MacUser@127.0.0.1" 'id -u').Trim()
if (-not ($macUid -match '^\d+$')) {
  throw "Cannot resolve Mac uid: $macUid"
}
Invoke-Mac "launchctl bootout gui/$macUid ~/Library/LaunchAgents/com.codex.remote.mac-reverse-access.plist >/dev/null 2>&1 || true; launchctl bootstrap gui/$macUid ~/Library/LaunchAgents/com.codex.remote.mac-reverse-access.plist; launchctl enable gui/$macUid/com.codex.remote.mac-reverse-access; launchctl kickstart -k gui/$macUid/com.codex.remote.mac-reverse-access"

Write-Host "Mac reverse access LaunchAgent installed." -ForegroundColor Green
