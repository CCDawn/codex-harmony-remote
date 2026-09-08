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
  param($G, [string]$Text, [float]$X, [float]$Y, [float]$Size, [string]$Color = '#EDF2F8', [System.Drawing.FontStyle]$Style = [System.Drawing.FontStyle]::Regular)
  $font = New-Font $Size $Style
  $brush = New-Brush $Color
  $G.DrawString($Text, $font, $brush, [System.Drawing.PointF]::new($X, $Y))
  $font.Dispose()
  $brush.Dispose()
}

function Draw-Pill {
  param($G, [float]$X, [float]$Y, [float]$W, [string]$Text)
  Fill-RoundRect $G $X $Y $W 54 27 '#11161D' '#29323F'
  Draw-Text $G $Text ($X + 34) ($Y + 13) 20 '#EDF2F8' ([System.Drawing.FontStyle]::Bold)
}

function Draw-PhoneBase {
  param(
    $G,
    [string]$Title,
    [string]$Subtitle,
    [bool]$ShowTopPlus = $true
  )
  $G.Clear((New-Color '#090C10'))
  $white = New-Brush '#11161D'
  $G.FillRectangle($white, 0, 0, $width, 88)
  $white.Dispose()
  Draw-Text $G '09:41' 32 30 26 '#EDF2F8' ([System.Drawing.FontStyle]::Bold)
  Draw-Text $G '5G  82%' 575 32 18 '#EDF2F8' ([System.Drawing.FontStyle]::Bold)
  Draw-Text $G $Title 28 116 38 '#EDF2F8' ([System.Drawing.FontStyle]::Bold)
  if (-not [string]::IsNullOrWhiteSpace($Subtitle)) {
    Draw-Text $G $Subtitle 30 174 20 '#98A5B5'
  }
  if ($ShowTopPlus) {
    Fill-RoundRect $G 650 126 46 46 23 '#11161D' '#29323F'
    Draw-Text $G '+' 662 127 34 '#EDF2F8'
  }
}

function Draw-Composer {
  param($G, [bool]$Running = $false)
  Fill-RoundRect $G 34 1374 576 116 20 '#11161D' ''
  Fill-RoundRect $G 624 1376 58 58 29 '#11161D' '#29323F'
  Draw-Text $G '+' 640 1376 36 '#EDF2F8'
  $sendColor = if ($Running) { '#EA6969' } else { '#24476D' }
  $sendText = if ($Running) { '×' } else { '↑' }
  Fill-RoundRect $G 624 1450 58 58 29 $sendColor ''
  Draw-Text $G $sendText 640 1449 34 '#11161D'
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

# These are code-rendered UI illustrations, never captures of a real account.
function Draw-DemoList {
  param($g)
  Draw-PhoneBase $g '会话' '共 6 个会话 · 2 个进行中'
  Draw-Text $g '下拉刷新会话，左滑会话可删除' 30 244 20 '#98A5B5'
  Draw-Text $g '项目' 30 330 20 '#98A5B5'
  Draw-Text $g '⌄   示例项目' 30 388 26 '#98A5B5'
  $rows = @(
    @{ title = '完善产品主页'; meta = '运行中'; active = $true },
    @{ title = '整理组件样式'; meta = '5 分钟前'; active = $false },
    @{ title = '更新使用文档'; meta = '1 小时前'; active = $false }
  )
  $y = 475
  foreach ($row in $rows) {
    $color = if ($row.active) { '#67A8FF' } else { '#556476' }
    Draw-Text $g '○' 32 ($y + 3) 24 $color
    Draw-Text $g $row.title 82 $y 27 '#EDF2F8' ([System.Drawing.FontStyle]::Bold)
    Draw-Text $g $row.meta 572 ($y + 6) 18 '#98A5B5'
    $y += 112
  }
  Draw-Text $g '最近' 30 868 20 '#98A5B5'
  $recent = @('检查接口返回', '优化页面布局', '阅读项目结构')
  $y = 942
  foreach ($title in $recent) {
    Draw-Text $g '○' 32 $y 24 '#67A8FF'
    Draw-Text $g $title 82 $y 27 '#EDF2F8' ([System.Drawing.FontStyle]::Bold)
    Draw-Text $g '刚刚' 598 ($y + 6) 18 '#98A5B5'
    $y += 112
  }
  Draw-Text $g '演示数据 · 非真实账号截图' 210 1500 18 '#718095'
}
function Draw-DemoChat {
  param($g)
  Draw-PhoneBase $g '完善产品主页' 'Codex' $false
  Draw-Pill $g 455 128 232 'GPT-6-Astra · 中'
  Draw-Text $g '09:41  你' 588 260 18 '#98A5B5'
  Fill-RoundRect $g 152 305 535 116 18 '#152B46' '#294A70'
  Draw-Text $g '请整理主页布局，并检查构建。' 178 345 25 '#EDF2F8'
  Draw-Text $g '●  Codex  09:42' 32 480 20 '#67A8FF'
  Draw-Text $g '我会检查现有组件，复用项目里的样式。' 32 534 25 '#EDF2F8'
  Fill-RoundRect $g 32 638 656 140 16 '#11161D' '#29323F'
  Draw-Text $g '>_   执行命令' 60 664 24 '#EDF2F8' ([System.Drawing.FontStyle]::Bold)
  Draw-Text $g 'npm run build' 60 712 22 '#98A5B5'
  Draw-Text $g '完成' 602 671 18 '#81C6A3'
  Fill-RoundRect $g 32 812 656 145 16 '#11161D' '#29323F'
  Draw-Text $g '<>   文件变更' 60 839 24 '#EDF2F8' ([System.Drawing.FontStyle]::Bold)
  Draw-Text $g 'src/pages/Home.tsx     +24  -8' 60 889 22 '#98A5B5'
  Draw-Text $g '●  Codex  09:43' 32 1022 20 '#67A8FF'
  Draw-Text $g '主页布局已调整，构建通过。' 32 1080 26 '#EDF2F8'
  Draw-Text $g '保留了现有导航，统一了内容间距。' 32 1126 25 '#EDF2F8'
  Draw-Text $g '复制     分享' 32 1202 20 '#98A5B5'
  Draw-Composer $g $false
  Draw-Text $g '演示数据 · 非真实账号截图' 210 1520 17 '#718095'
}
New-Screenshot -Path (Join-Path $OutputDir 'app-session-list-redacted.png') -Draw { param($g) Draw-DemoList $g }
New-Screenshot -Path (Join-Path $OutputDir 'app-chat-thread-redacted.png') -Draw { param($g) Draw-DemoChat $g }
New-Screenshot -Path (Join-Path $OutputDir 'app-account-usage-demo.png') -Draw {
  param($g)
  Draw-PhoneBase $g '账号用量' '额度窗口与重置时间 · 演示数据' $false
  $rows = @(
    @{ label='套餐'; value='Pro' },
    @{ label='每周限制'; value='剩余 75% · 已用 25%'; reset='重置 09-15 09:00' },
    @{ label='GPT-5.3-Codex-Spark · 5小时限制'; value='剩余 90% · 已用 10%'; reset='重置 09-08 14:00' },
    @{ label='GPT-5.3-Codex-Spark · 每周限制'; value='剩余 85% · 已用 15%'; reset='重置 09-15 09:00' }
  )
  $y=280
  foreach($row in $rows) {
    Fill-RoundRect $g 30 $y 660 226 18 '#11161D' '#29323F'
    Draw-Text $g $row.label 58 ($y+25) 22 '#98A5B5'
    Draw-Text $g $row.value 58 ($y+77) 29 '#EDF2F8' ([System.Drawing.FontStyle]::Bold)
    if($row.ContainsKey('reset')) { Draw-Text $g $row.reset 58 ($y+151) 21 '#98A5B5' }
    $y+=260
  }
  Draw-Text $g '额度由桌面同实例 App Server 提供' 58 1375 22 '#67A8FF'
  Draw-Text $g '演示数据 · 非真实账号截图' 210 1500 18 '#718095'
}
$width=1640
$height=1060
New-Screenshot -Path (Join-Path $OutputDir 'app-tablet-demo.png') -Draw {
  param($g)
  $g.Clear((New-Color '#090C10'))
  Fill-RoundRect $g 0 0 460 1060 1 '#11161D' ''
  Draw-Text $g '会话' 32 38 34 '#EDF2F8' ([System.Drawing.FontStyle]::Bold)
  Draw-Text $g '共 6 个会话 · 2 个进行中' 32 92 20 '#98A5B5'
  Draw-Text $g '项目 / 示例项目' 32 177 22 '#98A5B5'
  Fill-RoundRect $g 18 232 424 80 14 '#202D40' ''
  Draw-Text $g '○   完善产品主页' 38 255 26 '#EDF2F8'
  Draw-Text $g '整理组件样式' 76 358 26 '#EDF2F8'
  Draw-Text $g '更新使用文档' 76 456 26 '#EDF2F8'
  Draw-Text $g '最近' 32 582 22 '#98A5B5'
  Draw-Text $g '○   检查接口返回' 38 659 26 '#EDF2F8'
  Draw-Text $g '优化页面布局' 76 757 26 '#EDF2F8'
  Draw-Text $g '阅读项目结构' 76 855 26 '#EDF2F8'
  Draw-Text $g '完善产品主页' 502 42 31 '#EDF2F8' ([System.Drawing.FontStyle]::Bold)
  Draw-Pill $g 1210 40 235 'GPT-6-Astra · 中'
  Draw-Pill $g 1468 40 130 '桌面'
  Fill-RoundRect $g 954 170 640 104 18 '#152B46' '#294A70'
  Draw-Text $g '请整理主页布局，并检查构建。' 985 204 26 '#EDF2F8'
  Draw-Text $g '●  Codex  09:42' 510 325 21 '#67A8FF'
  Draw-Text $g '我会检查现有组件，复用项目里的样式。' 510 377 26 '#EDF2F8'
  Fill-RoundRect $g 510 458 1060 112 16 '#11161D' '#29323F'
  Draw-Text $g '>_   npm run build' 542 494 26 '#EDF2F8'
  Draw-Text $g '完成' 1480 501 20 '#81C6A3'
  Fill-RoundRect $g 510 604 1060 112 16 '#11161D' '#29323F'
  Draw-Text $g '<>   src/pages/Home.tsx' 542 639 26 '#EDF2F8'
  Draw-Text $g '+24  -8' 1445 646 20 '#81C6A3'
  Draw-Text $g '主页布局已调整，构建通过。' 510 776 27 '#EDF2F8'
  Fill-RoundRect $g 510 879 984 110 18 '#11161D' '#29323F'
  Draw-Pill $g 1520 898 80 '+'
  Draw-Text $g '演示布局与数据 · 非真实账号截图' 622 1020 18 '#718095'
}
Write-Host "Generated public demo images in $OutputDir" -ForegroundColor Green
