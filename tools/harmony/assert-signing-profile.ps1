[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$ProfilePath,
  [Parameter(Mandatory = $true)]
  [string]$BundleName
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (!(Test-Path -LiteralPath $ProfilePath)) {
  throw "签名 profile 不存在: $ProfilePath"
}

$dump = certutil -dump $ProfilePath 2>&1 | Out-String
$hex = [regex]::Matches($dump, '\b[0-9a-fA-F]{2}\b') | ForEach-Object { [Convert]::ToByte($_.Value, 16) }
$text = [System.Text.Encoding]::UTF8.GetString([byte[]]$hex)
$match = [regex]::Match($text, '"bundle-name"\s*:\s*"([^"]+)"')
if (!$match.Success) {
  throw "无法从 profile 读取 bundle-name: $ProfilePath"
}

$actual = $match.Groups[1].Value
if ($actual -ne $BundleName) {
  throw "签名 profile 包名不匹配。当前 profile 绑定: $actual，需要: $BundleName。请在 DevEco Studio 为 Helper 生成独立调试签名 profile。"
}

Write-Host "签名 profile 匹配: $BundleName" -ForegroundColor Green
