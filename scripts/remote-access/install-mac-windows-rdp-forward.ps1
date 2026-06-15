[CmdletBinding()]
param(
  [string]$MacUser = 'mac',
  [int]$MacLocalSshPort = 22222,
  [string]$ServerPublicHost = 'root@<your-relay-server>',
  [int]$LocalRdpPort = 3390,
  [int]$ServerRdpPort = 13389
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$watchdogLocal = Join-Path $scriptRoot 'mac-windows-rdp-forward-watchdog.sh'
if (-not (Test-Path -LiteralPath $watchdogLocal)) {
  throw "Missing watchdog script: $watchdogLocal"
}

function Invoke-Mac {
  param([string]$Command)
  & ssh -p $MacLocalSshPort "$MacUser@127.0.0.1" $Command
}

Write-Host "Uploading Mac Windows RDP forward watchdog..." -ForegroundColor Cyan
Invoke-Mac "mkdir -p ~/codex-remote-link ~/codex-remote-link/logs ~/Library/LaunchAgents"
& scp -P $MacLocalSshPort $watchdogLocal "${MacUser}@127.0.0.1:~/codex-remote-link/mac-windows-rdp-forward-watchdog.sh"
Invoke-Mac "chmod +x ~/codex-remote-link/mac-windows-rdp-forward-watchdog.sh"

$plist = @"
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.codex.remote.mac-windows-rdp-forward</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>/Users/$MacUser/codex-remote-link/mac-windows-rdp-forward-watchdog.sh</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>SSH_HOST</key>
    <string>$ServerPublicHost</string>
    <key>LOCAL_RDP_PORT</key>
    <string>$LocalRdpPort</string>
    <key>SERVER_RDP_PORT</key>
    <string>$ServerRdpPort</string>
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
  <string>/Users/$MacUser/codex-remote-link/logs/mac-windows-rdp-forward.launch.out.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/$MacUser/codex-remote-link/logs/mac-windows-rdp-forward.launch.err.log</string>
</dict>
</plist>
"@

$tmpPlist = Join-Path $env:TEMP 'com.codex.remote.mac-windows-rdp-forward.plist'
$plist | Set-Content -LiteralPath $tmpPlist -Encoding UTF8
& scp -P $MacLocalSshPort $tmpPlist "${MacUser}@127.0.0.1:~/Library/LaunchAgents/com.codex.remote.mac-windows-rdp-forward.plist"
Remove-Item -LiteralPath $tmpPlist -Force -ErrorAction SilentlyContinue

$macUid = (& ssh -p $MacLocalSshPort "$MacUser@127.0.0.1" 'id -u').Trim()
if (-not ($macUid -match '^\d+$')) {
  throw "Cannot resolve Mac uid: $macUid"
}

Write-Host "Loading Mac Windows RDP forward LaunchAgent..." -ForegroundColor Cyan
Invoke-Mac "launchctl bootout gui/$macUid ~/Library/LaunchAgents/com.codex.remote.mac-windows-rdp-forward.plist >/dev/null 2>&1 || true; launchctl bootstrap gui/$macUid ~/Library/LaunchAgents/com.codex.remote.mac-windows-rdp-forward.plist; launchctl enable gui/$macUid/com.codex.remote.mac-windows-rdp-forward; launchctl kickstart -k gui/$macUid/com.codex.remote.mac-windows-rdp-forward"

Write-Host "Mac Windows RDP forward LaunchAgent installed. Connect Windows App to 127.0.0.1:$LocalRdpPort on the Mac." -ForegroundColor Green
