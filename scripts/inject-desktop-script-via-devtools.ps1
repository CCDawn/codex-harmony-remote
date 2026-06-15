[CmdletBinding()]
param(
  [string]$BridgeUrl = 'http://127.0.0.1:8787',
  [string]$BridgeToken = $env:CODEX_BRIDGE_TOKEN,
  [int]$WaitSeconds = 12
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class Win32Window {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
}
'@
Add-Type -AssemblyName System.Windows.Forms

function Write-Step {
  param([string]$Message)
  Write-Host ""
  Write-Host "==> $Message" -ForegroundColor Cyan
}

function Get-CodexWindowProcess {
  Get-Process -Name 'Codex' -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -match 'Codex' } |
    Sort-Object StartTime -Descending |
    Select-Object -First 1
}

function Focus-Window {
  param([System.Diagnostics.Process]$Process)
  [Win32Window]::ShowWindowAsync($Process.MainWindowHandle, 9) | Out-Null
  Start-Sleep -Milliseconds 300
  [Win32Window]::SetForegroundWindow($Process.MainWindowHandle) | Out-Null
  Start-Sleep -Milliseconds 500
}

function Invoke-BridgeJson {
  param([string]$Url)
  $headers = @{}
  if (-not [string]::IsNullOrWhiteSpace($BridgeToken)) {
    $headers['X-Codex-Bridge-Token'] = $BridgeToken
  }
  Invoke-RestMethod -Uri $Url -Headers $headers -TimeoutSec 8
}

$BridgeUrl = $BridgeUrl.TrimEnd('/')
$headersJson = if ([string]::IsNullOrWhiteSpace($BridgeToken)) {
  '{}'
} else {
  (@{ 'X-Codex-Bridge-Token' = $BridgeToken } | ConvertTo-Json -Compress)
}
$scriptUrl = "$BridgeUrl/desktop/script/client.js"
$snippet = "fetch('$scriptUrl', { headers: $headersJson }).then(r => r.text()).then(code => (0, eval)(code))"

Write-Step "定位 Codex 桌面窗口"
$codex = Get-CodexWindowProcess
if (-not $codex) {
  throw '没有找到可聚焦的 Codex 桌面窗口'
}
Write-Host "Codex PID=$($codex.Id), Title=$($codex.MainWindowTitle)" -ForegroundColor DarkGray

Write-Step "打开 DevTools Console"
Focus-Window -Process $codex
[System.Windows.Forms.SendKeys]::SendWait('^+j')
Start-Sleep -Seconds 3

Write-Step "粘贴并执行 bridge 注入脚本"
Set-Clipboard -Value $snippet
[System.Windows.Forms.SendKeys]::SendWait('^v')
Start-Sleep -Milliseconds 400
[System.Windows.Forms.SendKeys]::SendWait('{ENTER}')

Write-Step "等待桌面脚本桥上线"
$deadline = (Get-Date).AddSeconds($WaitSeconds)
$lastStatus = $null
while ((Get-Date) -lt $deadline) {
  try {
    $lastStatus = Invoke-BridgeJson -Url "$BridgeUrl/desktop/script/status"
    if ($lastStatus.bridge.online -eq $true) {
      $lastStatus | ConvertTo-Json -Depth 8
      exit 0
    }
  } catch {
    $lastStatus = @{ error = $_.Exception.Message }
  }
  Start-Sleep -Milliseconds 700
}

Write-Host "桌面脚本桥仍未上线，最后状态：" -ForegroundColor Yellow
$lastStatus | ConvertTo-Json -Depth 8
exit 2
