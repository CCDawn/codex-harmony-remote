[CmdletBinding()]
param(
  [string]$DeviceId = '',
  [string]$HdcPath = 'C:\openHarmony\20\toolchains\hdc.exe',
  [string]$VirtualConfigPath = '',
  [string]$OutputDir = '',
  [string]$Name = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($VirtualConfigPath)) {
  $VirtualConfigPath = Join-Path $repoRoot 'tools\harmony\virtual-hdc.local.psd1'
}
if ([string]::IsNullOrWhiteSpace($OutputDir)) {
  $OutputDir = Join-Path $repoRoot 'logs\screenshots'
}

if (-not (Test-Path -LiteralPath $HdcPath)) {
  throw "HDC not found: $HdcPath"
}

if ([string]::IsNullOrWhiteSpace($DeviceId)) {
  if (Test-Path -LiteralPath $VirtualConfigPath) {
    $virtual = Import-PowerShellDataFile -LiteralPath $VirtualConfigPath
    $phoneIp = if ($virtual.ContainsKey('PhoneIp')) { [string]$virtual.PhoneIp } else { '' }
    $isPlaceholder = $phoneIp -match '^<.*>$' -or $phoneIp -match 'phone-virtual-ip'
    if (-not [string]::IsNullOrWhiteSpace($phoneIp) -and -not $isPlaceholder) {
      $port = if ($virtual.ContainsKey('Port') -and -not [string]::IsNullOrWhiteSpace([string]$virtual.Port)) { [int]$virtual.Port } else { 10178 }
      $DeviceId = "$phoneIp`:$port"
    }
  }
}

if ([string]::IsNullOrWhiteSpace($DeviceId)) {
  $targets = @(& $HdcPath list targets 2>&1 | Where-Object {
    $text = [string]$_
    -not [string]::IsNullOrWhiteSpace($text) -and
      $text -notmatch '^\[|^List of|^$'
  })
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to list HDC targets: $($targets -join "`n")"
  }
  if ($targets.Count -eq 0) {
    throw 'No HDC device found. Please connect a phone and try again.'
  }
  if ($targets.Count -gt 1) {
    throw "Multiple HDC devices found. Pass -DeviceId explicitly: $($targets -join ', ')"
  }
  $DeviceId = [string]$targets[0]
}

New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

$timestamp = Get-Date -Format 'yyyyMMdd_HHmmss'
if ([string]::IsNullOrWhiteSpace($Name)) {
  $Name = "screen_$timestamp"
}

$safeName = $Name -replace '[^\w.-]+', '_'
if (-not $safeName.EndsWith('.jpeg')) {
  $safeName = "$safeName.jpeg"
}

$remotePath = "/data/local/tmp/$safeName"
$localPath = Join-Path $OutputDir $safeName

$snapshotOutput = & $HdcPath -t $DeviceId shell "snapshot_display -f $remotePath" 2>&1
if ($LASTEXITCODE -ne 0 -or ($snapshotOutput -join "`n") -match '\[Fail\]|failed|error:|invalid') {
  throw "Device screenshot failed: $($snapshotOutput -join "`n")"
}

$recvOutput = & $HdcPath -t $DeviceId file recv $remotePath $localPath 2>&1
if ($LASTEXITCODE -ne 0 -or ($recvOutput -join "`n") -match '\[Fail\]|failed|error:') {
  throw "Screenshot download failed: $($recvOutput -join "`n")"
}

& $HdcPath -t $DeviceId shell "rm -f $remotePath" | Out-Null

$file = Get-Item -LiteralPath $localPath
Write-Host "Screenshot: $($file.FullName)" -ForegroundColor Green
Write-Host "Size: $($file.Length) bytes" -ForegroundColor DarkGray
