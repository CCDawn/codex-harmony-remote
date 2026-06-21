@echo off
setlocal EnableExtensions DisableDelayedExpansion
chcp 65001 >nul 2>&1
title Codex Toolbox

set "TOOLBOX_DIR=%~dp0"
for %%I in ("%TOOLBOX_DIR%..\..") do set "CODEX_REMOTE_ROOT=%%~fI"
set "CODEX_REMOTE_START=%CODEX_REMOTE_ROOT%\scripts\start-codex-mobile-stack.ps1"
if "%CODEX_PROVIDER_SWITCH%"=="" set "CODEX_PROVIDER_SWITCH=%USERPROFILE%\Documents\Codex\provider-switch\run-switch-codex-provider.cmd"
if "%CODEX_OFFICIAL_SWITCH%"=="" set "CODEX_OFFICIAL_SWITCH=%USERPROFILE%\Documents\Codex\provider-switch\run-switch-codex-official.cmd"
if "%CODEX_MAINTENANCE%"=="" set "CODEX_MAINTENANCE=%USERPROFILE%\Documents\Codex\tools\codex-maintenance"
if "%CODEX_PRUNE_SCRIPT%"=="" set "CODEX_PRUNE_SCRIPT=%USERPROFILE%\Documents\Codex\tools\codex-maintenance\prune_codex_sessions.py"

:menu
cls
echo.
echo  ==========================================
echo        Codex Toolbox v1.0
echo  ==========================================
echo.
echo   1. 启动手机远程
echo   2. 安全切换 Provider
echo   3. 切换到官方账号
echo   4. 清理历史会话
echo   5. 清理 Codex 日志
echo   6. 分析会话占用
echo   7. 归档冷会话
echo   8. 恢复归档会话
echo   0. 退出
echo.
echo  ==========================================
echo.
set "choice="
set /p "choice=  请选择 [0-8]: "

if "%choice%"=="0" goto exit
if "%choice%"=="8" goto restore
if "%choice%"=="7" goto archive
if "%choice%"=="6" goto analyze
if "%choice%"=="5" goto cleanlogs
if "%choice%"=="4" goto cleanup
if "%choice%"=="3" goto official
if "%choice%"=="2" goto provider
if "%choice%"=="1" goto remote
goto menu

:cleanup
cls
echo.
echo  ---- 清理历史会话 ----
echo.
set "SCRIPT_PATH=%~f0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$p = $env:SCRIPT_PATH; $l = Get-Content -LiteralPath $p -Encoding UTF8; $m = '#PS1_START'; $i = [Array]::IndexOf($l, $m); if ($i -lt 0) { Write-Host 'Marker not found' -ForegroundColor Red; pause; exit 1 }; $s = ($l[($i+1)..($l.Length-1)] -join [Environment]::NewLine); & ([scriptblock]::Create($s))"
echo.
echo  返回主菜单...
timeout /t 2 >nul
goto menu

:provider
cls
echo.
echo  ---- 安全切换 Provider ----
echo.
if not exist "%CODEX_PROVIDER_SWITCH%" (
  echo  Provider 切换脚本不存在:
  echo  %CODEX_PROVIDER_SWITCH%
  pause
  goto menu
)
call "%CODEX_PROVIDER_SWITCH%"
echo.
echo  返回主菜单...
timeout /t 2 >nul
goto menu

:official
cls
echo.
echo  ---- 切换到官方账号 ----
echo.
if not exist "%CODEX_OFFICIAL_SWITCH%" (
  echo  官方账号切换脚本不存在:
  echo  %CODEX_OFFICIAL_SWITCH%
  pause
  goto menu
)
call "%CODEX_OFFICIAL_SWITCH%"
echo.
echo  返回主菜单...
timeout /t 2 >nul
goto menu

:remote
cls
echo.
echo  ---- 启动手机远程 ----
echo.
if not exist "%CODEX_REMOTE_START%" (
  echo  手机远程启动脚本不存在:
  echo  %CODEX_REMOTE_START%
  pause
  goto menu
)
pushd "%CODEX_REMOTE_ROOT%" >nul
start "Codex 手机远程" powershell.exe -NoProfile -ExecutionPolicy Bypass -NoExit -File "%CODEX_REMOTE_START%"
popd >nul
echo  手机远程启动脚本已在新窗口运行。
echo.
echo  返回主菜单...
timeout /t 2 >nul
goto menu

:cleanlogs
cls
echo.
echo  ---- 清理 Codex 日志 ----
echo  只清理日志，不修改会话历史。
echo.
if not exist "%CODEX_MAINTENANCE%\Clean-Codex-Logs.ps1" (
  echo  日志清理脚本不存在:
  echo  %CODEX_MAINTENANCE%\Clean-Codex-Logs.ps1
  pause
  goto menu
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%CODEX_MAINTENANCE%\Clean-Codex-Logs.ps1"
echo.
echo  返回主菜单...
timeout /t 2 >nul
goto menu

:analyze
cls
echo.
echo  ---- 分析会话占用 ----
echo  只读分析，不修改任何文件。
echo.
if not exist "%CODEX_MAINTENANCE%\Analyze-Codex-Sessions.ps1" (
  echo  会话分析脚本不存在:
  echo  %CODEX_MAINTENANCE%\Analyze-Codex-Sessions.ps1
  pause
  goto menu
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%CODEX_MAINTENANCE%\Analyze-Codex-Sessions.ps1"
echo.
echo  返回主菜单...
timeout /t 2 >nul
goto menu

:archive
cls
echo.
echo  ---- 归档冷会话 ----
echo  先预览，输入 ARCHIVE 才会执行。
echo.
if not exist "%CODEX_MAINTENANCE%\Archive-Codex-Cold-Sessions.ps1" (
  echo  归档脚本不存在:
  echo  %CODEX_MAINTENANCE%\Archive-Codex-Cold-Sessions.ps1
  pause
  goto menu
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%CODEX_MAINTENANCE%\Archive-Codex-Cold-Sessions.ps1"
echo.
set /p "THREAD_ID=可选：输入 ThreadId 手动归档，直接回车使用自动候选："
if not "%THREAD_ID%"=="" (
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%CODEX_MAINTENANCE%\Archive-Codex-Cold-Sessions.ps1" -IncludeThreadId "%THREAD_ID%"
  echo.
)
set /p "CONFIRM=确认执行请输入 ARCHIVE，直接回车取消："
if /I not "%CONFIRM%"=="ARCHIVE" (
  echo  已取消。
  echo.
  echo  返回主菜单...
  timeout /t 2 >nul
  goto menu
)
if "%THREAD_ID%"=="" (
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%CODEX_MAINTENANCE%\Archive-Codex-Cold-Sessions.ps1" -Apply
) else (
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%CODEX_MAINTENANCE%\Archive-Codex-Cold-Sessions.ps1" -IncludeThreadId "%THREAD_ID%" -Apply
)
echo.
echo  返回主菜单...
timeout /t 2 >nul
goto menu

:restore
cls
echo.
echo  ---- 恢复归档会话 ----
echo.
if not exist "%CODEX_MAINTENANCE%\Restore-Codex-Archived-Session.ps1" (
  echo  恢复脚本不存在:
  echo  %CODEX_MAINTENANCE%\Restore-Codex-Archived-Session.ps1
  pause
  goto menu
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%CODEX_MAINTENANCE%\Restore-Codex-Archived-Session.ps1" -List
echo.
set /p "THREAD_ID=输入要恢复的 ThreadId，直接回车取消："
if "%THREAD_ID%"=="" (
  echo  已取消。
  echo.
  echo  返回主菜单...
  timeout /t 2 >nul
  goto menu
)
set /p "CONFIRM=确认恢复请输入 RESTORE："
if /I not "%CONFIRM%"=="RESTORE" (
  echo  已取消。
  echo.
  echo  返回主菜单...
  timeout /t 2 >nul
  goto menu
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%CODEX_MAINTENANCE%\Restore-Codex-Archived-Session.ps1" -ThreadId "%THREAD_ID%" -Apply
echo.
echo  返回主菜单...
timeout /t 2 >nul
goto menu

:exit
echo.
echo  已退出
exit /b 0

#PS1_START
$ErrorActionPreference = "Stop"

$RetentionHours = 72
$PruneScript = $env:CODEX_PRUNE_SCRIPT
$CodexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE ".codex" }
$Desktop = [Environment]::GetFolderPath("Desktop")
$Stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$BackupRoot = Join-Path $Desktop "codex_cleanup_backup_$Stamp"
$ReportPath = Join-Path $BackupRoot "prune_report.json"
$ConsoleLog = Join-Path $BackupRoot "cleanup_console.log"

try {
    Write-Host "  保留时间    : $RetentionHours 小时"
    Write-Host "  Codex 目录  : $CodexHome"
    Write-Host "  清理脚本    : $PruneScript"
    Write-Host ""

    if (-not (Test-Path -LiteralPath $PruneScript)) { throw "清理脚本不存在: $PruneScript" }
    if (-not (Test-Path -LiteralPath $CodexHome)) { throw "Codex 目录不存在: $CodexHome" }

    $runningCodex = Get-Process -Name "Codex","codex" -ErrorAction SilentlyContinue
    if ($runningCodex) {
        Write-Host "  Codex 正在运行，请先关闭 Codex 再执行清理。" -ForegroundColor Yellow
        Read-Host "按回车返回"
        exit 2
    }

    New-Item -ItemType Directory -Force -Path $BackupRoot | Out-Null

    Write-Host "  正在执行清理..." -ForegroundColor Cyan
    Write-Host "  备份目录: $BackupRoot"
    Write-Host ""

    $arguments = @($PruneScript, "--codex-home", $CodexHome, "--retention-hours", "$RetentionHours", "--include-logs", "--backup-root", $BackupRoot, "--report", $ReportPath, "--apply")
    & python @arguments 2>&1 | Tee-Object -FilePath $ConsoleLog
    if ($LASTEXITCODE -ne 0) { throw "清理脚本执行失败，退出码 $LASTEXITCODE" }

    Write-Host ""
    Write-Host "  清理后文件快照:" -ForegroundColor Cyan
    foreach ($t in @("$CodexHome\logs_2.sqlite","$CodexHome\logs_2.sqlite-wal","$CodexHome\state_5.sqlite","$CodexHome\state_5.sqlite-wal")) {
        if (Test-Path -LiteralPath $t) { $item = Get-Item -LiteralPath $t; "  {0,8:N2} MB  {1}" -f ($item.Length / 1MB), $item.FullName }
    }

    Write-Host ""
    Write-Host "  剩余最大的会话文件:" -ForegroundColor Cyan
    Get-ChildItem -LiteralPath (Join-Path $CodexHome "sessions") -Recurse -Force -File -ErrorAction SilentlyContinue | Sort-Object Length -Descending | Select-Object -First 10 @{Name="MB";Expression={[math]::Round($_.Length / 1MB, 2)}}, LastWriteTime, FullName | Format-Table -AutoSize -Wrap

    Write-Host "  清理完成! 备份已保存至:" -ForegroundColor Green
    Write-Host "  $BackupRoot" -ForegroundColor Green
}
catch {
    Write-Host ""
    Write-Host "  清理失败: $($_.Exception.Message)" -ForegroundColor Red
}
Read-Host "按回车返回"
