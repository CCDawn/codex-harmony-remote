[CmdletBinding()]
param(
  [int]$Port = 8787,
  [string]$Token = '',
  [string]$Workspace = '',
  [string]$Adapter = 'codex'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($Workspace)) {
  $Workspace = $repoRoot
}
if ([string]::IsNullOrWhiteSpace($Token)) {
  $bytes = New-Object byte[] 24
  [System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
  $Token = [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

$env:CODEX_BRIDGE_TOKEN = $Token

Write-Host "启动带访问令牌的 Codex bridge..." -ForegroundColor Cyan
Write-Host "Token: $Token" -ForegroundColor Yellow

Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | ForEach-Object {
  Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue
}
Start-Sleep -Seconds 1

$bridge = Start-Process -FilePath 'powershell.exe' `
  -ArgumentList @('-ExecutionPolicy', 'Bypass', '-File', (Join-Path $repoRoot 'scripts\start-bridge-lan.ps1'), '-Port', [string]$Port, '-Workspace', $Workspace, '-Adapter', $Adapter) `
  -WorkingDirectory $repoRoot `
  -WindowStyle Hidden `
  -PassThru

for ($i = 0; $i -lt 20; $i++) {
  Start-Sleep -Milliseconds 500
  try {
    Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -Headers @{ 'X-Codex-Bridge-Token' = $Token } -TimeoutSec 2 | Out-Null
    break
  } catch {
    if ($i -eq 19) {
      throw "Bridge 未能启动或 Token 验证失败。"
    }
  }
}

$cloudflared = Get-Command cloudflared -ErrorAction SilentlyContinue
if ($cloudflared) {
  Write-Host "使用 cloudflared 创建公网临时隧道..." -ForegroundColor Cyan
  Write-Host "手机端令牌填写上面的 Token。" -ForegroundColor DarkGray
  & $cloudflared.Source tunnel --url "http://127.0.0.1:$Port"
  exit $LASTEXITCODE
}

$npx = Get-Command npx -ErrorAction SilentlyContinue
if ($npx) {
  Write-Host "未找到 cloudflared，使用 npx localtunnel 创建公网临时隧道..." -ForegroundColor Cyan
  Write-Host "手机端令牌填写上面的 Token。" -ForegroundColor DarkGray
  & $npx.Source --yes localtunnel --port $Port
  exit $LASTEXITCODE
}

try {
  Stop-Process -Id $bridge.Id -Force -ErrorAction SilentlyContinue
} catch {
}
throw "未找到 cloudflared 或 npx，无法自动创建公网隧道。"
