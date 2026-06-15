[CmdletBinding()]
param(
  [string]$PhoneIp = '',

  [int]$Port = 10178,

  [string]$UsbDeviceId = '',

  [switch]$EnableTcpOnUsb,

  [switch]$Deploy,

  [switch]$Build,

  [string]$BridgeUrl = '',

  [string]$ConfigPath = '',

  [string]$VirtualConfigPath = ''
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

function Resolve-RepoRoot {
  param([string]$ScriptRoot)
  return [System.IO.Path]::GetFullPath((Join-Path $ScriptRoot '..\..'))
}

function Find-HdcPath {
  param(
    [hashtable]$Config,
    [string]$RepoRoot
  )

  $candidates = New-Object System.Collections.Generic.List[string]
  if ($Config.ContainsKey('HdcPath') -and -not [string]::IsNullOrWhiteSpace([string]$Config.HdcPath)) {
    $candidates.Add([string]$Config.HdcPath)
  }
  $cmd = Get-Command hdc -ErrorAction SilentlyContinue
  if ($cmd) {
    $candidates.Add($cmd.Source)
  }
  $candidates.Add('C:\openHarmony\20\toolchains\hdc.exe')
  $candidates.Add('D:\DevEco Studio\sdk\default\openharmony\toolchains\hdc.exe')

  foreach ($candidate in $candidates) {
    if (-not [string]::IsNullOrWhiteSpace($candidate) -and (Test-Path -LiteralPath $candidate)) {
      return (Resolve-Path -LiteralPath $candidate).Path
    }
  }

  throw "未找到 hdc.exe。请把 hdc 加入 PATH，或在配置中填写 HdcPath。"
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

function Invoke-HdcChecked {
  param(
    [string]$HdcExe,
    [string[]]$Args,
    [int]$TimeoutSeconds = 30
  )

  Write-Info ("执行: {0} {1}" -f $HdcExe, ($Args -join ' '))
  $psi = [System.Diagnostics.ProcessStartInfo]::new()
  $psi.FileName = $HdcExe
  $psi.Arguments = ($Args | ForEach-Object {
    $value = [string]$_
    if ($value -match '\s|"') {
      '"' + $value.Replace('"', '\"') + '"'
    } else {
      $value
    }
  }) -join ' '
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.UseShellExecute = $false
  $process = [System.Diagnostics.Process]::Start($psi)
  if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
    $process.Kill($true)
    throw "执行 hdc 超时（${TimeoutSeconds}s）: $($Args -join ' ')"
  }
  $output = @($process.StandardOutput.ReadToEnd(), $process.StandardError.ReadToEnd()) -join "`n"
  if (-not [string]::IsNullOrWhiteSpace($output)) {
    $output.Trim() | Write-Host
  }
  if ($process.ExitCode -ne 0 -or $output -match '\[Fail\]|failed|error') {
    throw "hdc 命令失败: $($Args -join ' ')"
  }
  return $output
}

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Resolve-RepoRoot -ScriptRoot $scriptRoot
if ([string]::IsNullOrWhiteSpace($ConfigPath)) {
  $ConfigPath = Join-Path $scriptRoot 'codex-remote.config.psd1'
}
if ([string]::IsNullOrWhiteSpace($VirtualConfigPath)) {
  $VirtualConfigPath = Join-Path $scriptRoot 'virtual-hdc.local.psd1'
}
if (-not (Test-Path -LiteralPath $ConfigPath)) {
  throw "配置文件不存在: $ConfigPath"
}

$config = Import-PowerShellDataFile -LiteralPath $ConfigPath
$virtualConfig = @{}
if (Test-Path -LiteralPath $VirtualConfigPath) {
  $virtualConfig = Import-PowerShellDataFile -LiteralPath $VirtualConfigPath
}

$PhoneIp = [string](Get-ConfigValue -Config $virtualConfig -Key 'PhoneIp' -DefaultValue $PhoneIp)
$Port = [int](Get-ConfigValue -Config $virtualConfig -Key 'Port' -DefaultValue $Port)
$UsbDeviceId = [string](Get-ConfigValue -Config $virtualConfig -Key 'UsbDeviceId' -DefaultValue $UsbDeviceId)
if ([string]::IsNullOrWhiteSpace($BridgeUrl)) {
  $BridgeUrl = [string](Get-ConfigValue -Config $virtualConfig -Key 'BridgeUrl' -DefaultValue $BridgeUrl)
}
if ([string]::IsNullOrWhiteSpace($PhoneIp) -or $PhoneIp -match '^<.*>$') {
  throw "缺少 PhoneIp。请传入 -PhoneIp，或复制 tools\harmony\virtual-hdc.example.psd1 为 virtual-hdc.local.psd1 后填写 PhoneIp。"
}

$hdcExe = Find-HdcPath -Config $config -RepoRoot $repoRoot
$target = "${PhoneIp}:$Port"

Write-Step "准备虚拟组网 HDC"
Write-Info "HDC: $hdcExe"
Write-Info "目标: $target"

if ($EnableTcpOnUsb) {
  Write-Step "通过 USB 开启手机 TCP HDC 端口"
  $args = @()
  if (-not [string]::IsNullOrWhiteSpace($UsbDeviceId)) {
    $args += @('-t', $UsbDeviceId)
  }
  $args += @('tmode', 'port', [string]$Port)
  Invoke-HdcChecked -HdcExe $hdcExe -Args $args -TimeoutSeconds 30 | Out-Null
  Write-Info "已请求手机监听 TCP 端口 $Port。现在可以拔线后继续使用虚拟网 IP。"
}

Write-Step "连接虚拟网设备"
try {
  Invoke-HdcChecked -HdcExe $hdcExe -Args @('tconn', $target) -TimeoutSeconds 30 | Out-Null
} catch {
  Write-Info "连接命令返回异常，继续检查在线列表: $($_.Exception.Message)"
}

$targets = & $hdcExe list targets 2>&1
$targets | Write-Host
if (($targets -join "`n") -notmatch [Regex]::Escape($target)) {
  throw "没有看到虚拟网设备在线: $target。请确认手机已加入虚拟网、IP 正确、端口 $Port 未被拦截。"
}

Write-Step "连接完成"
Write-Host "虚拟网 HDC 已在线: $target" -ForegroundColor Green

if ($Deploy) {
  Write-Step "通过虚拟网部署 Codex Remote"
  $deployArgs = @('-ExecutionPolicy', 'Bypass', '-File', (Join-Path $scriptRoot 'deploy.ps1'), '-DeviceId', $target, '-UseLanBridge')
  if ($Build) {
    $deployArgs += '-Build'
  }
  if (-not [string]::IsNullOrWhiteSpace($BridgeUrl)) {
    $deployArgs += @('-BridgeUrl', $BridgeUrl)
  }
  & powershell @deployArgs
}
