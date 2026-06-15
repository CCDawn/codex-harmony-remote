[CmdletBinding()]
param(
  [string]$OutputDir = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
if ([string]::IsNullOrWhiteSpace($OutputDir)) {
  $OutputDir = Join-Path $repoRoot 'assets\readme'
}
$OutputDir = [System.IO.Path]::GetFullPath($OutputDir)
New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

Add-Type -AssemblyName System.Drawing

$width = 720
$height = 1548
$fontFamily = 'Microsoft YaHei UI'

function New-Color {
  param([string]$Hex)
  return [System.Drawing.ColorTranslator]::FromHtml($Hex)
}

function New-Font {
  param(
    [float]$Size,
    [System.Drawing.FontStyle]$Style = [System.Drawing.FontStyle]::Regular
  )
  return [System.Drawing.Font]::new($fontFamily, $Size, $Style, [System.Drawing.GraphicsUnit]::Pixel)
}

function New-Brush {
  param([string]$Hex)
  return [System.Drawing.SolidBrush]::new((New-Color $Hex))
}

function New-Pen {
  param(
    [string]$Hex,
    [float]$Width = 1
  )
  return [System.Drawing.Pen]::new((New-Color $Hex), $Width)
}

function New-RoundPath {
  param(
    [float]$X,
    [float]$Y,
    [float]$W,
    [float]$H,
    [float]$R
  )
  $path = [System.Drawing.Drawing2D.GraphicsPath]::new()
  $d = $R * 2
  $path.AddArc($X, $Y, $d, $d, 180, 90)
  $path.AddArc($X + $W - $d, $Y, $d, $d, 270, 90)
  $path.AddArc($X + $W - $d, $Y + $H - $d, $d, $d, 0, 90)
  $path.AddArc($X, $Y + $H - $d, $d, $d, 90, 90)
  $path.CloseFigure()
  return $path
}

function Fill-RoundRect {
  param($G, [float]$X, [float]$Y, [float]$W, [float]$H, [float]$R, [string]$Fill, [string]$Stroke = '')
  $path = New-RoundPath -X $X -Y $Y -W $W -H $H -R $R
  $brush = New-Brush $Fill
  $G.FillPath($brush, $path)
  $brush.Dispose()
  if (-not [string]::IsNullOrWhiteSpace($Stroke)) {
    $pen = New-Pen $Stroke 1.5
    $G.DrawPath($pen, $path)
    $pen.Dispose()
  }
  $path.Dispose()
}

function Draw-Text {
  param($G, [string]$Text, [float]$X, [float]$Y, [float]$Size, [string]$Color = '#111827', [System.Drawing.FontStyle]$Style = [System.Drawing.FontStyle]::Regular)
  $font = New-Font $Size $Style
  $brush = New-Brush $Color
  $G.DrawString($Text, $font, $brush, [System.Drawing.PointF]::new($X, $Y))
  $font.Dispose()
  $brush.Dispose()
}

function Draw-Pill {
  param($G, [float]$X, [float]$Y, [float]$W, [string]$Text)
  Fill-RoundRect $G $X $Y $W 54 27 '#FFFFFF' '#DDE3EA'
  Draw-Text $G $Text ($X + 34) ($Y + 13) 20 '#1F2937' ([System.Drawing.FontStyle]::Bold)
}

function Draw-PhoneBase {
  param(
    $G,
    [string]$Title,
    [string]$Subtitle,
    [bool]$ShowTopPlus = $true
  )
  $G.Clear((New-Color '#F7F8FB'))
  $white = New-Brush '#FFFFFF'
  $G.FillRectangle($white, 0, 0, $width, 88)
  $white.Dispose()
  Draw-Text $G '09:41' 32 30 26 '#111827' ([System.Drawing.FontStyle]::Bold)
  Draw-Text $G '5G  82%' 575 32 18 '#111827' ([System.Drawing.FontStyle]::Bold)
  Draw-Text $G $Title 28 116 38 '#111827' ([System.Drawing.FontStyle]::Bold)
  if (-not [string]::IsNullOrWhiteSpace($Subtitle)) {
    Draw-Text $G $Subtitle 30 174 20 '#7B8494'
  }
  if ($ShowTopPlus) {
    Fill-RoundRect $G 650 126 46 46 23 '#FFFFFF' '#DDE3EA'
    Draw-Text $G '+' 662 127 34 '#111827'
  }
}

function Draw-Composer {
  param($G, [bool]$Running = $false)
  Fill-RoundRect $G 34 1374 576 116 20 '#FFFFFF' ''
  Fill-RoundRect $G 624 1376 58 58 29 '#FFFFFF' '#DDE3EA'
  Draw-Text $G '+' 640 1376 36 '#111827'
  $sendColor = if ($Running) { '#BC1B12' } else { '#CDD4DF' }
  $sendText = if ($Running) { '×' } else { '↑' }
  Fill-RoundRect $G 624 1450 58 58 29 $sendColor ''
  Draw-Text $G $sendText 640 1449 34 '#FFFFFF'
}

function New-Screenshot {
  param([string]$Path, [scriptblock]$Draw)
  $bitmap = [System.Drawing.Bitmap]::new($width, $height)
  $g = [System.Drawing.Graphics]::FromImage($bitmap)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
  & $Draw $g
  $bitmap.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose()
  $bitmap.Dispose()
}

New-Screenshot -Path (Join-Path $OutputDir 'app-session-list-redacted.png') -Draw {
  param($g)
  Draw-PhoneBase $g '会话' '共 12 个会话 · 1 个进行中 · 2 个未读'
  Draw-Text $g '下拉刷新会话，左滑会话可删除' 30 230 20 '#9AA3AF'
  Fill-RoundRect $g 28 278 664 64 14 '#FFF7DE' ''
  Draw-Text $g '置顶' 46 294 24 '#A87000' ([System.Drawing.FontStyle]::Bold)
  Draw-Text $g '1 进行中' 602 298 18 '#A87000'
  $rows = @(
    @{ dot = '#2B80EA'; title = 'Codex 远程部署'; meta = '刚刚'; sub = '主项目' },
    @{ dot = '#E5E7EB'; title = '示例项目管理'; meta = '1 天前'; sub = '项目' },
    @{ dot = '#2B80EA'; title = '前端开发会话'; meta = '2 分钟前'; sub = '4 未读' },
    @{ dot = '#2B80EA'; title = '链路恢复测试'; meta = '13 分钟前'; sub = '' },
    @{ dot = '#E5E7EB'; title = '文档整理'; meta = '26 分钟前'; sub = '' },
    @{ dot = '#2B80EA'; title = 'Agent 任务中心'; meta = '44 分钟前'; sub = '' },
    @{ dot = '#E5E7EB'; title = '调试记录'; meta = '9 小时前'; sub = '' }
  )
  $y = 380
  foreach ($row in $rows) {
    $brush = New-Brush $row.dot
    $g.FillEllipse($brush, 42, $y + 24, 22, 22)
    $brush.Dispose()
    Draw-Text $g $row.title 92 $y 28 '#111827' ([System.Drawing.FontStyle]::Bold)
    if ($row.sub) { Draw-Text $g $row.sub 92 ($y + 44) 18 '#9AA3AF' }
    Draw-Text $g $row.meta 594 ($y + 10) 20 '#8B95A1'
    $y += 112
  }
  Draw-Text $g '脱敏示例 · 内容为占位数据' 224 1490 16 '#B0B7C3'
}

New-Screenshot -Path (Join-Path $OutputDir 'app-chat-thread-redacted.png') -Draw {
  param($g)
  Draw-PhoneBase $g '示例项目 / 远程会话' 'Codex' $false
  Draw-Pill $g 470 126 210 '思考 · 自动'
  Draw-Text $g 'Codex  09:41' 30 244 18 '#8B95A1'
  Draw-Text $g '已连接桌面实时通道，正在同步当前会话。' 30 288 24 '#111827'
  Draw-Text $g '工具调用会以结构化组件展示，最终回答保留在对话中。' 30 330 24 '#111827'
  Fill-RoundRect $g 142 444 544 128 18 '#EAF5FF' '#CFE5FF'
  Draw-Text $g '请检查链路状态，并继续当前任务。' 176 474 24 '#111827'
  Draw-Text $g '09:42  你' 576 408 18 '#8B95A1'
  Draw-Text $g 'Codex  09:42' 30 626 18 '#8B95A1'
  Fill-RoundRect $g 30 670 626 98 16 '#FFFFFF' '#E3E8EF'
  Draw-Text $g '正在准备 Codex 运行环境' 66 692 22 '#111827' ([System.Drawing.FontStyle]::Bold)
  Draw-Text $g '正在执行命令' 66 728 18 '#2B80EA'
  Fill-RoundRect $g 30 810 626 126 16 '#FFFFFF' '#E3E8EF'
  Draw-Text $g 'Git 变动' 66 834 22 '#111827' ([System.Drawing.FontStyle]::Bold)
  Draw-Text $g '已整理为可展开组件，敏感路径已隐藏。' 66 876 18 '#6B7280'
  Fill-RoundRect $g 30 980 626 110 16 '#FFFFFF' '#E3E8EF'
  Draw-Text $g '桌面截图附件' 66 1006 22 '#111827' ([System.Drawing.FontStyle]::Bold)
  Draw-Text $g '点击可预览，发送前可删除。' 66 1048 18 '#6B7280'
  Fill-RoundRect $g 30 1228 626 66 33 '#FFFFFF' ''
  Draw-Text $g '桌面实时连接 · 正常' 64 1246 20 '#1F8F5F' ([System.Drawing.FontStyle]::Bold)
  Draw-Composer $g $true
  Draw-Text $g '脱敏示例 · 内容为占位数据' 224 1508 16 '#B0B7C3'
}

New-Screenshot -Path (Join-Path $OutputDir 'app-structured-actions-redacted.png') -Draw {
  param($g)
  Draw-PhoneBase $g '示例会话' 'Example Project' $false
  Draw-Pill $g 470 126 210 '模型 · 自动'
  Draw-Text $g 'Codex  09:46' 30 242 18 '#8B95A1'
  Draw-Text $g '操作结果会折叠成组件，便于手机端快速浏览。' 30 284 24 '#111827'

  Fill-RoundRect $g 30 380 660 250 18 '#FFFFFF' '#DEE5EE'
  Fill-RoundRect $g 52 410 60 60 14 '#EEF7FF' ''
  Draw-Text $g '□' 70 418 34 '#2B80EA'
  Draw-Text $g '创建 Git 分支' 132 406 24 '#111827' ([System.Drawing.FontStyle]::Bold)
  Draw-Text $g '操作 · 创建分支' 132 452 18 '#6B7280'
  Draw-Text $g '分支  feature/example-task' 132 500 18 '#111827'
  Draw-Text $g '工作区  <project-worktree>' 132 542 18 '#2B80EA'
  Draw-Text $g '指令  ::git-create-branch{...}' 132 584 18 '#6B7280'

  Fill-RoundRect $g 30 658 660 190 18 '#FFFFFF' '#DEE5EE'
  Fill-RoundRect $g 52 688 60 60 14 '#EFFFF7' ''
  Draw-Text $g '+' 72 690 36 '#11A36A'
  Draw-Text $g '暂存 Git 改动' 132 684 24 '#111827' ([System.Drawing.FontStyle]::Bold)
  Draw-Text $g '工作区  <project-worktree>' 132 734 18 '#2B80EA'
  Draw-Text $g '指令  ::git-stage{...}' 132 778 18 '#6B7280'

  Fill-RoundRect $g 30 880 660 150 18 '#FFFFFF' '#DEE5EE'
  Fill-RoundRect $g 52 910 60 60 14 '#F2F7FF' ''
  Draw-Text $g '<>' 62 928 22 '#2B80EA'
  Draw-Text $g '记忆引用' 132 906 24 '#111827' ([System.Drawing.FontStyle]::Bold)
  Draw-Text $g 'MEMORY.md · 已脱敏摘要' 132 956 18 '#6B7280'

  Fill-RoundRect $g 472 1260 58 58 29 '#FFFFFF' '#DDE3EA'
  Draw-Text $g '▣' 490 1274 22 '#111827'
  Fill-RoundRect $g 548 1260 58 58 29 '#FFFFFF' '#DDE3EA'
  Draw-Text $g '/' 570 1267 30 '#111827'
  Fill-RoundRect $g 624 1260 58 58 29 '#FFFFFF' '#DDE3EA'
  Draw-Text $g '+' 640 1260 36 '#111827'
  Draw-Composer $g $false
  Draw-Text $g '脱敏示例 · 内容为占位数据' 224 1508 16 '#B0B7C3'
}

Write-Host "Generated README screenshots in $OutputDir" -ForegroundColor Green
