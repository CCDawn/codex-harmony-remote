[CmdletBinding()]
param(
  [string]$VirtualConfigPath = '',
  [switch]$WriteConfig
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $scriptRoot '..\..'))
if ([string]::IsNullOrWhiteSpace($VirtualConfigPath)) {
  $VirtualConfigPath = Join-Path $scriptRoot 'virtual-hdc.local.psd1'
}

$adapters = @(Get-NetIPAddress -AddressFamily IPv4 | Where-Object {
  $_.IPAddress -notlike '127.*' -and
  ($_.InterfaceAlias -match 'aTrust|Sangfor|Tailscale|ZeroTier|WireGuard|本地连接')
})

$windowsVirtualIp = ''
if ($adapters.Count -gt 0) {
  $preferred = $adapters | Sort-Object @{
    Expression = {
      if ($_.InterfaceAlias -match 'aTrust|Sangfor|本地连接') { 0 } else { 1 }
    }
  } | Select-Object -First 1
  $windowsVirtualIp = [string]$preferred.IPAddress
}

$phoneIps = @()
try {
  $rawIfconfig = & hdc shell "ifconfig 2>/dev/null || ip addr 2>/dev/null" 2>&1
  $phoneIps = @([regex]::Matches(($rawIfconfig -join "`n"), 'inet addr:(\d+\.\d+\.\d+\.\d+)|inet\s+(\d+\.\d+\.\d+\.\d+)') | ForEach-Object {
    $value = if ($_.Groups[1].Value) { $_.Groups[1].Value } else { $_.Groups[2].Value }
    if ($value -notlike '127.*') { $value }
  })
} catch {
}

$candidatePhoneIp = ''
if ($windowsVirtualIp -match '^(\d+\.\d+\.\d+)\.') {
  $prefix = $Matches[1]
  $candidatePhoneIp = [string](@($phoneIps | Where-Object { $_ -like "$prefix.*" } | Select-Object -First 1))
}

[pscustomobject]@{
  WindowsVirtualIp = $windowsVirtualIp
  PhoneCandidateIp = $candidatePhoneIp
  PhoneIps = $phoneIps -join ', '
  ConfigPath = $VirtualConfigPath
} | Format-List | Out-String | Write-Host

if ($WriteConfig) {
  if ([string]::IsNullOrWhiteSpace($windowsVirtualIp)) {
    throw "没有找到电脑虚拟网 IP。"
  }
  $phoneValue = if ([string]::IsNullOrWhiteSpace($candidatePhoneIp)) { '<phone-virtual-ip>' } else { $candidatePhoneIp }
  $content = @"
@{
  PhoneIp = '$phoneValue'
  Port = 10178
  UsbDeviceId = '<your-usb-device-id>'
  BridgeUrl = 'http://${windowsVirtualIp}:8787'
  BridgePort = 8787
  Workspace = '$repoRoot'
  Adapter = 'codex'
  Token = ''
}
"@
  [System.IO.File]::WriteAllText($VirtualConfigPath, $content, [System.Text.UTF8Encoding]::new($false))
  Write-Host "已写入配置: $VirtualConfigPath" -ForegroundColor Green
}
