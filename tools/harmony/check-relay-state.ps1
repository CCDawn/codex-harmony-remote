[CmdletBinding()]
param(
  [string]$ConfigPath = '',
  [string]$BridgeToken = $env:CODEX_BRIDGE_TOKEN,
  [switch]$SkipDesktopScreenshot
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Write-Step {
  param([string]$Message)
  Write-Host ""
  Write-Host "==> $Message" -ForegroundColor Cyan
}

function Write-Info {
  param([string]$Message)
  Write-Host "    $Message" -ForegroundColor DarkGray
}

function Get-StateArray {
  param(
    [object]$State,
    [string]$Name
  )
  $property = $State.PSObject.Properties[$Name]
  if ($null -eq $property -or $null -eq $property.Value) {
    return @()
  }
  return @($property.Value)
}

if ([string]::IsNullOrWhiteSpace($ConfigPath)) {
  $ConfigPath = Join-Path $PSScriptRoot 'hdc-relay.local.psd1'
}
if (-not (Test-Path -LiteralPath $ConfigPath)) {
  throw "缺少 HDC Relay 配置: $ConfigPath"
}

$config = Import-PowerShellDataFile -LiteralPath $ConfigPath
$relayHost = if ($config.RelayHost) { [string]$config.RelayHost } else { '<your-relay-server>' }
$relayPort = if ($config.RelayPort) { [int]$config.RelayPort } else { 19078 }
$relayToken = if ($config.Token) { [string]$config.Token } else { '' }
$deviceId = if ($config.DeviceId) { [string]$config.DeviceId } else { 'default' }
$proxyHost = if ($config.ProxyHost) { [string]$config.ProxyHost } else { '127.0.0.1' }
$proxyPort = if ($config.ProxyPort) { [int]$config.ProxyPort } else { 11078 }
$hdcPath = if ($config.HdcPath) { [string]$config.HdcPath } else { 'C:\openHarmony\20\toolchains\hdc.exe' }

Write-Step "公网 Relay 状态"
$stateUrl = "http://${relayHost}:${relayPort}/__relay/state?token=$([uri]::EscapeDataString($relayToken))"
$stateResponse = Invoke-RestMethod -UseBasicParsing -Uri $stateUrl -TimeoutSec 8
$state = $stateResponse.state
$phones = Get-StateArray -State $state -Name 'phones'
$pendingPc = Get-StateArray -State $state -Name 'pendingPc'
$activeHdc = Get-StateArray -State $state -Name 'activeHdc'
Write-Info "phones: $($phones -join ', ')"
Write-Info "pendingPc: $($pendingPc -join ', ')"
Write-Info "activeHdc: $($activeHdc -join ', ')"
Write-Info "bridgePc: $($state.bridgePc)"

$hasPhone = $phones -contains $deviceId
$hasPendingPc = $pendingPc -contains $deviceId
$hasActiveHdc = $activeHdc -contains $deviceId
$hasBridge = [int]$state.bridgePc -gt 0
$hdcConnected = $false
$hdcShellReady = $false

if ($hasBridge) {
  Write-Host "    桌面 bridge 公网池：正常" -ForegroundColor Green
} else {
  Write-Host "    桌面 bridge 公网池：离线，请启动 bridge-proxy" -ForegroundColor Yellow
}

if ($hasActiveHdc) {
  Write-Host "    手机 HDC helper：正在与电脑 HDC 转发" -ForegroundColor Green
} elseif ($hasPhone) {
  Write-Host "    手机 HDC helper：在线等待电脑" -ForegroundColor Green
} elseif ($hasPendingPc) {
  Write-Host "    手机 HDC 中继：离线；电脑端正在等待 device=$deviceId。单 App 模式请打开主 App；Helper 模式请打开中继助手。" -ForegroundColor Yellow
} else {
  Write-Host "    手机 HDC 中继：未挂起；单 App 模式请打开主 App，Helper 模式请打开中继助手。" -ForegroundColor Yellow
}

Write-Step "本地代理状态"
$listener = Get-NetTCPConnection -LocalAddress $proxyHost -LocalPort $proxyPort -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($listener) {
  Write-Host "    HDC proxy 监听：${proxyHost}:$proxyPort PID=$($listener.OwningProcess)" -ForegroundColor Green
} else {
  Write-Host "    HDC proxy 未监听：${proxyHost}:$proxyPort" -ForegroundColor Yellow
}

if (Test-Path -LiteralPath $hdcPath) {
  $targets = @(& $hdcPath list targets -v 2>&1)
  Write-Info "hdc targets:"
  foreach ($line in $targets) {
    Write-Host "      $line" -ForegroundColor DarkGray
    if ($line -match [regex]::Escape("${proxyHost}:$proxyPort") -and $line -match '\bConnected\b') {
      $hdcConnected = $true
    }
  }

  if ($hdcConnected) {
    $probe = @(& $hdcPath -t "${proxyHost}:$proxyPort" shell echo codex-link-ok 2>&1)
    if ($LASTEXITCODE -eq 0 -and (($probe -join "`n") -match 'codex-link-ok')) {
      $hdcShellReady = $true
    } else {
      Write-Info "hdc shell probe:"
      foreach ($line in $probe) {
        Write-Host "      $line" -ForegroundColor DarkGray
      }
    }
  }
} else {
  Write-Host "    HDC 不存在: $hdcPath" -ForegroundColor Yellow
}

if ($hdcShellReady) {
  Write-Host "    HDC 通道：已连接且 shell 可用；relay phones 为空属于通道被占用后的正常表现" -ForegroundColor Green
} elseif ($hdcConnected) {
  Write-Host "    HDC 通道：列表显示已连接，但 shell 探针失败；需要重连 HDC/本地 proxy。" -ForegroundColor Yellow
}

if (-not $SkipDesktopScreenshot -and $hasBridge) {
  Write-Step "公网桌面 bridge 验证"
  try {
    $headers = @{ 'X-Codex-Bridge-Token' = $BridgeToken }
    $image = (Invoke-RestMethod -UseBasicParsing -Method Post -Uri "http://${relayHost}:${relayPort}/desktop/screenshot/primary" -Headers $headers -TimeoutSec 20).image
    Write-Host "    主屏截图接口：正常 $($image.width)x$($image.height), $($image.bytes) bytes" -ForegroundColor Green
  } catch {
    Write-Host "    主屏截图接口：失败 $($_.Exception.Message)" -ForegroundColor Yellow
  }
}

Write-Step "诊断结论"
if ($hasBridge -and ($hasActiveHdc -or $hdcShellReady)) {
  Write-Host "公网 bridge 正常；HDC shell 可用，手机 helper 正在转发或被当前通道占用。" -ForegroundColor Green
} elseif ($hasBridge -and $hdcConnected) {
  Write-Host "公网 bridge 正常；HDC 处于假连接状态，等待 watchdog 自动重连，或手动重启 HDC proxy/helper。" -ForegroundColor Yellow
} elseif ($hasBridge -and $hasPhone) {
  Write-Host "公网 bridge 与手机 HDC helper 都在线，可以尝试 hdc tconn ${proxyHost}:$proxyPort。" -ForegroundColor Green
} elseif ($hasBridge -and $hasPendingPc) {
  Write-Host "公网 bridge 正常；HDC 卡在电脑等待手机中继。单 App 模式请打开主 App，Helper 模式请打开中继助手。" -ForegroundColor Yellow
} elseif ($hasBridge) {
  Write-Host "公网 bridge 正常；手机 HDC 中继没有在线。手机会话/截图可走公网 bridge，远程部署需要打开承载中继的 App。" -ForegroundColor Yellow
} else {
  Write-Host "公网 bridge 离线，先重启本地 bridge-proxy。" -ForegroundColor Yellow
}
