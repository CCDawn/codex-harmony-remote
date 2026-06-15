[CmdletBinding()]
param(
  [string]$VirtualConfigPath = '',
  [switch]$SetupUsbTcp,
  [switch]$NoBuild,
  [switch]$Watch,
  [int]$WatchSeconds = 20
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

function Get-ConfigValue {
  param(
    [hashtable]$Config,
    [string]$Key,
    [object]$DefaultValue
  )
  if ($Config.ContainsKey($Key) -and $null -ne $Config[$Key] -and -not [string]::IsNullOrWhiteSpace([string]$Config[$Key])) {
    return $Config[$Key]
  }
  return $DefaultValue
}

function Stop-PortListener {
  param([int]$Port)
  Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | ForEach-Object {
    Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue
  }
}

function Wait-BridgeHealth {
  param(
    [int]$Port,
    [string]$Token
  )
  $headers = @{}
  if (-not [string]::IsNullOrWhiteSpace($Token)) {
    $headers['X-Codex-Bridge-Token'] = $Token
  }
  for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Milliseconds 500
    try {
      Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -Headers $headers -TimeoutSec 2 | Out-Null
      return
    } catch {
    }
  }
  throw "Bridge 健康检查失败: http://127.0.0.1:$Port/health"
}

function Test-HdcTargetOnline {
  param(
    [string]$HdcExe,
    [string]$Target
  )
  $targets = @(& $HdcExe list targets 2>&1)
  return (($targets -join "`n") -match [Regex]::Escape($Target))
}

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $scriptRoot '..\..'))
if ([string]::IsNullOrWhiteSpace($VirtualConfigPath)) {
  $VirtualConfigPath = Join-Path $scriptRoot 'virtual-hdc.local.psd1'
}
if (-not (Test-Path -LiteralPath $VirtualConfigPath)) {
  $example = Join-Path $scriptRoot 'virtual-hdc.example.psd1'
  throw "缺少虚拟组网配置: $VirtualConfigPath`n请复制 $example 为 virtual-hdc.local.psd1，并填写 PhoneIp 与 BridgeUrl。"
}

$virtual = Import-PowerShellDataFile -LiteralPath $VirtualConfigPath
$phoneIp = [string](Get-ConfigValue -Config $virtual -Key 'PhoneIp' -DefaultValue '')
$port = [int](Get-ConfigValue -Config $virtual -Key 'Port' -DefaultValue 10178)
$bridgeUrl = [string](Get-ConfigValue -Config $virtual -Key 'BridgeUrl' -DefaultValue '')
$bridgePort = [int](Get-ConfigValue -Config $virtual -Key 'BridgePort' -DefaultValue 8787)
$workspace = [string](Get-ConfigValue -Config $virtual -Key 'Workspace' -DefaultValue $repoRoot)
$adapter = [string](Get-ConfigValue -Config $virtual -Key 'Adapter' -DefaultValue 'codex')
$token = [string](Get-ConfigValue -Config $virtual -Key 'Token' -DefaultValue '')

if ([string]::IsNullOrWhiteSpace($phoneIp) -or $phoneIp -match '^<.*>$') {
  throw "virtual-hdc.local.psd1 缺少 PhoneIp。"
}
if ([string]::IsNullOrWhiteSpace($bridgeUrl) -or $bridgeUrl -match '^http://$|^<.*>$') {
  throw "virtual-hdc.local.psd1 缺少 BridgeUrl。"
}

$target = "${phoneIp}:$port"

Write-Step "启动本地 Codex Bridge"
Stop-PortListener -Port $bridgePort
$processLogDir = Join-Path $repoRoot 'logs\bridge-process'
New-Item -ItemType Directory -Path $processLogDir -Force | Out-Null
$stdoutPath = Join-Path $processLogDir 'auto-dev.stdout.log'
$stderrPath = Join-Path $processLogDir 'auto-dev.stderr.log'
Remove-Item -LiteralPath $stdoutPath, $stderrPath -Force -ErrorAction SilentlyContinue

$bridgeArgs = @('-ExecutionPolicy', 'Bypass', '-File', (Join-Path $repoRoot 'scripts\start-bridge-lan.ps1'), '-Port', [string]$bridgePort, '-Workspace', $workspace, '-Adapter', $adapter)
$env:CODEX_BRIDGE_TOKEN = $token
$bridge = Start-Process -FilePath 'powershell.exe' `
  -ArgumentList $bridgeArgs `
  -WorkingDirectory $repoRoot `
  -WindowStyle Hidden `
  -RedirectStandardOutput $stdoutPath `
  -RedirectStandardError $stderrPath `
  -PassThru
Write-Info "Bridge PID=$($bridge.Id)"
Write-Info "Bridge URL=$bridgeUrl"
Wait-BridgeHealth -Port $bridgePort -Token $token

Write-Step "连接虚拟网 HDC 并部署"
$connectArgs = @('-ExecutionPolicy', 'Bypass', '-File', (Join-Path $scriptRoot 'connect-virtual-hdc.ps1'), '-VirtualConfigPath', $VirtualConfigPath, '-Deploy', '-BridgeUrl', $bridgeUrl)
if ($SetupUsbTcp) {
  $connectArgs += '-EnableTcpOnUsb'
}
if (-not $NoBuild) {
  $connectArgs += '-Build'
}
& powershell @connectArgs

if (-not $Watch) {
  Write-Step "自动对齐完成"
  Write-Host "Bridge 与虚拟网 HDC 已连接，App 已按配置部署。" -ForegroundColor Green
  return
}

Write-Step "进入自动巡检"
$hdcConfig = Import-PowerShellDataFile -LiteralPath (Join-Path $scriptRoot 'codex-remote.config.psd1')
$hdcExe = [string]$hdcConfig.HdcPath
while ($true) {
  Start-Sleep -Seconds $WatchSeconds
  try {
    Wait-BridgeHealth -Port $bridgePort -Token $token
    if (-not (Test-HdcTargetOnline -HdcExe $hdcExe -Target $target)) {
      Write-Info "HDC 目标离线，尝试重连: $target"
      & powershell -ExecutionPolicy Bypass -File (Join-Path $scriptRoot 'connect-virtual-hdc.ps1') -VirtualConfigPath $VirtualConfigPath
    }
    Write-Info "巡检正常: bridge ok, hdc=$target"
  } catch {
    Write-Host "巡检发现异常: $($_.Exception.Message)" -ForegroundColor Yellow
  }
}
