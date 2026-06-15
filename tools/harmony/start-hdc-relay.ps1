[CmdletBinding()]
param(
  [ValidateSet('Server', 'Proxy', 'PhoneHelperNode', 'BridgeProxy')]
  [string]$Mode = 'Proxy',
  [string]$ConfigPath = '',
  [string]$RelayHost = '',
  [int]$RelayPort = 0,
  [string]$Token = '',
  [string]$DeviceId = '',
  [int]$ProxyPort = 0,
  [int]$HdcdPort = 0
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$projectRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..')
if ([string]::IsNullOrWhiteSpace($ConfigPath)) {
  $ConfigPath = Join-Path $PSScriptRoot 'hdc-relay.local.psd1'
}

$config = @{}
if (Test-Path -LiteralPath $ConfigPath) {
  $config = Import-PowerShellDataFile -LiteralPath $ConfigPath
}

function Read-ConfigValue([string]$Name, $Fallback) {
  if ($config.ContainsKey($Name) -and $null -ne $config[$Name] -and "$($config[$Name])".Trim().Length -gt 0) {
    return $config[$Name]
  }
  return $Fallback
}

$relayHostValue = if ($RelayHost.Trim().Length -gt 0) { $RelayHost } else { Read-ConfigValue 'RelayHost' '' }
$relayPortValue = if ($RelayPort -gt 0) { $RelayPort } else { [int](Read-ConfigValue 'RelayPort' 19078) }
$tokenValue = if ($Token.Trim().Length -gt 0) { $Token } else { Read-ConfigValue 'Token' '' }
$deviceIdValue = if ($DeviceId.Trim().Length -gt 0) { $DeviceId } else { Read-ConfigValue 'DeviceId' 'default' }
$proxyHostValue = Read-ConfigValue 'ProxyHost' '127.0.0.1'
$proxyPortValue = if ($ProxyPort -gt 0) { $ProxyPort } else { [int](Read-ConfigValue 'ProxyPort' 11078) }
$hdcdHostValue = Read-ConfigValue 'HdcdHost' '127.0.0.1'
$hdcdPortValue = if ($HdcdPort -gt 0) { $HdcdPort } else { [int](Read-ConfigValue 'HdcdPort' 10178) }

if ($Mode -ne 'Server' -and [string]::IsNullOrWhiteSpace($relayHostValue)) {
  throw "RelayHost is required. Copy tools\harmony\hdc-relay.example.psd1 to hdc-relay.local.psd1 and fill it first."
}

$env:HDC_RELAY_HOSTNAME = $relayHostValue
$env:HDC_RELAY_HOST = if ($Mode -eq 'Server') { '0.0.0.0' } else { $relayHostValue }
$env:HDC_RELAY_PORT = "$relayPortValue"
$env:HDC_RELAY_TOKEN = "$tokenValue"
$env:HDC_RELAY_DEVICE_ID = "$deviceIdValue"
$env:HDC_PROXY_HOST = "$proxyHostValue"
$env:HDC_PROXY_PORT = "$proxyPortValue"
$env:HDC_HELPER_HDC_HOST = "$hdcdHostValue"
$env:HDC_HELPER_HDC_PORT = "$hdcdPortValue"

Push-Location $projectRoot
try {
  switch ($Mode) {
    'Server' {
      npm run hdc:relay
    }
    'Proxy' {
      npm run hdc:proxy
    }
    'PhoneHelperNode' {
      npm run hdc:helper:node
    }
    'BridgeProxy' {
      npm run bridge:relay-proxy
    }
  }
} finally {
  Pop-Location
}
