[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$startScript = Join-Path $PSScriptRoot 'start-stack.ps1'
$logDir = Join-Path $repoRoot 'logs\startup'
$transcriptPath = Join-Path $logDir 'desktop-launcher-transcript.log'
$errorPath = Join-Path $logDir 'desktop-launcher-error.log'
$transcriptStarted = $false

try {
  if (-not (Test-Path -LiteralPath $startScript)) {
    throw "Missing stack launcher: $startScript"
  }

  New-Item -ItemType Directory -Path $logDir -Force | Out-Null

  try {
    Start-Transcript -LiteralPath $transcriptPath -Append -Force | Out-Null
    $transcriptStarted = $true
  } catch {
    Write-Warning "无法写入启动过程日志，将继续启动: $($_.Exception.Message)"
  }

  & $startScript -ForceRestart
  if ($LASTEXITCODE -ne 0) {
    throw "一键启动脚本退出码为 $LASTEXITCODE"
  }
} catch {
  $errorLines = @(
    "time=$([DateTimeOffset]::Now.ToString('o'))"
    "message=$($_.Exception.Message)"
    "position=$($_.InvocationInfo.PositionMessage)"
    "stack=$($_.ScriptStackTrace)"
  )
  $errorLines | Set-Content -LiteralPath $errorPath -Encoding utf8

  Write-Host ''
  Write-Host 'Codex 远程模式启动失败，窗口将保留。' -ForegroundColor Red
  Write-Host "错误: $($_.Exception.Message)" -ForegroundColor Yellow
  Write-Host "错误日志: $errorPath" -ForegroundColor Cyan

  if ($transcriptStarted) {
    try {
      Stop-Transcript | Out-Null
    } catch {
      # The useful error is already persisted above.
    }
    $transcriptStarted = $false
  }

  [void](Read-Host '按 Enter 关闭窗口')
  exit 1
} finally {
  if ($transcriptStarted) {
    try {
      Stop-Transcript | Out-Null
    } catch {
      # Startup has already completed; transcript cleanup is best effort.
    }
  }
}

exit 0
