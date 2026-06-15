[CmdletBinding()]
param(
  [string]$RepoRoot = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($RepoRoot)) {
  $RepoRoot = Split-Path -Parent $PSScriptRoot
}

Add-Type -AssemblyName System.Drawing

function New-Color {
  param(
    [int]$A,
    [int]$R,
    [int]$G,
    [int]$B
  )
  return [System.Drawing.Color]::FromArgb($A, $R, $G, $B)
}

function New-Rect {
  param([float]$X, [float]$Y, [float]$W, [float]$H)
  return [System.Drawing.RectangleF]::new($X, $Y, $W, $H)
}

function New-RoundedRectPath {
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

function Fill-RoundedRect {
  param(
    [System.Drawing.Graphics]$Graphics,
    [System.Drawing.Brush]$Brush,
    [float]$X,
    [float]$Y,
    [float]$W,
    [float]$H,
    [float]$R
  )
  $path = New-RoundedRectPath -X $X -Y $Y -W $W -H $H -R $R
  try {
    $Graphics.FillPath($Brush, $path)
  } finally {
    $path.Dispose()
  }
}

function Stroke-RoundedRect {
  param(
    [System.Drawing.Graphics]$Graphics,
    [System.Drawing.Pen]$Pen,
    [float]$X,
    [float]$Y,
    [float]$W,
    [float]$H,
    [float]$R
  )
  $path = New-RoundedRectPath -X $X -Y $Y -W $W -H $H -R $R
  try {
    $Graphics.DrawPath($Pen, $path)
  } finally {
    $path.Dispose()
  }
}

function New-IconCanvas {
  param([int]$Size)
  $bitmap = [System.Drawing.Bitmap]::new($Size, $Size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
  return [pscustomobject]@{
    Bitmap = $bitmap
    Graphics = $graphics
    Size = $Size
  }
}

function Save-Icon {
  param(
    [System.Drawing.Bitmap]$Bitmap,
    [string]$Path
  )
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Path) | Out-Null
  $Bitmap.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
}

function Resize-Icon {
  param(
    [string]$Source,
    [string]$Target,
    [int]$Size
  )
  $sourceImage = [System.Drawing.Image]::FromFile($Source)
  $bitmap = [System.Drawing.Bitmap]::new($Size, $Size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  try {
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $graphics.DrawImage($sourceImage, 0, 0, $Size, $Size)
    Save-Icon -Bitmap $bitmap -Path $Target
  } finally {
    $graphics.Dispose()
    $bitmap.Dispose()
    $sourceImage.Dispose()
  }
}

function Draw-GlowLine {
  param(
    [System.Drawing.Graphics]$Graphics,
    [System.Drawing.PointF]$A,
    [System.Drawing.PointF]$B,
    [System.Drawing.Color]$Color
  )
  $wide = [System.Drawing.Pen]::new((New-Color 58 $Color.R $Color.G $Color.B), 44)
  $mid = [System.Drawing.Pen]::new((New-Color 130 $Color.R $Color.G $Color.B), 22)
  $core = [System.Drawing.Pen]::new($Color, 8)
  foreach ($pen in @($wide, $mid, $core)) {
    $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $Graphics.DrawLine($pen, $A, $B)
    $pen.Dispose()
  }
}

function Draw-RemoteIcon {
  param([string]$Path)
  $canvas = New-IconCanvas -Size 1024
  $g = $canvas.Graphics
  try {
    $bgRect = New-Rect 0 0 1024 1024
    $bg = [System.Drawing.Drawing2D.LinearGradientBrush]::new(
      $bgRect,
      (New-Color 255 7 10 16),
      (New-Color 255 20 88 88),
      42.0
    )
    $g.FillRectangle($bg, $bgRect)
    $bg.Dispose()

    $accentBrush = [System.Drawing.Drawing2D.LinearGradientBrush]::new(
      (New-Rect 88 90 820 820),
      (New-Color 70 31 111 235),
      (New-Color 46 28 185 129),
      20.0
    )
    $g.FillEllipse($accentBrush, 94, 86, 820, 820)
    $accentBrush.Dispose()

    $gridPen = [System.Drawing.Pen]::new((New-Color 28 255 255 255), 4)
    for ($i = 0; $i -lt 5; $i += 1) {
      $x = 190 + $i * 140
      $g.DrawLine($gridPen, $x, 190, $x + 120, 835)
    }
    $gridPen.Dispose()

    $shadow = [System.Drawing.SolidBrush]::new((New-Color 78 0 0 0))
    Fill-RoundedRect -Graphics $g -Brush $shadow -X 152 -Y 266 -W 572 -H 408 -R 58
    $shadow.Dispose()

    $terminalBrush = [System.Drawing.Drawing2D.LinearGradientBrush]::new(
      (New-Rect 132 238 572 408),
      (New-Color 255 13 18 25),
      (New-Color 255 29 38 50),
      90.0
    )
    Fill-RoundedRect -Graphics $g -Brush $terminalBrush -X 132 -Y 238 -W 572 -H 408 -R 58
    $terminalBrush.Dispose()

    $termBorder = [System.Drawing.Pen]::new((New-Color 210 255 255 255), 10)
    Stroke-RoundedRect -Graphics $g -Pen $termBorder -X 132 -Y 238 -W 572 -H 408 -R 58
    $termBorder.Dispose()

    $barBrush = [System.Drawing.SolidBrush]::new((New-Color 255 245 248 252))
    Fill-RoundedRect -Graphics $g -Brush $barBrush -X 164 -Y 272 -W 508 -H 62 -R 28
    $barBrush.Dispose()

    $dotColors = @(
      (New-Color 255 255 89 89),
      (New-Color 255 245 177 62),
      (New-Color 255 50 196 120)
    )
    for ($i = 0; $i -lt 3; $i += 1) {
      $dotBrush = [System.Drawing.SolidBrush]::new($dotColors[$i])
      $g.FillEllipse($dotBrush, 194 + $i * 40, 292, 20, 20)
      $dotBrush.Dispose()
    }

    $terminalPen = [System.Drawing.Pen]::new((New-Color 255 255 255 255), 22)
    $terminalPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $terminalPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $g.DrawLine($terminalPen, 222, 422, 290, 474)
    $g.DrawLine($terminalPen, 290, 474, 222, 526)
    $g.DrawLine($terminalPen, 348, 532, 528, 532)
    $terminalPen.Dispose()

    $cursorBrush = [System.Drawing.SolidBrush]::new((New-Color 255 49 196 141))
    Fill-RoundedRect -Graphics $g -Brush $cursorBrush -X 552 -Y 504 -W 66 -H 56 -R 16
    $cursorBrush.Dispose()

    $phoneShadow = [System.Drawing.SolidBrush]::new((New-Color 86 0 0 0))
    Fill-RoundedRect -Graphics $g -Brush $phoneShadow -X 574 -Y 362 -W 250 -H 390 -R 52
    $phoneShadow.Dispose()

    $phone = [System.Drawing.SolidBrush]::new((New-Color 255 246 250 255))
    Fill-RoundedRect -Graphics $g -Brush $phone -X 552 -Y 340 -W 250 -H 390 -R 52
    $phone.Dispose()

    $phoneScreen = [System.Drawing.SolidBrush]::new((New-Color 255 18 28 39))
    Fill-RoundedRect -Graphics $g -Brush $phoneScreen -X 582 -Y 390 -W 190 -H 288 -R 30
    $phoneScreen.Dispose()

    $notch = [System.Drawing.SolidBrush]::new((New-Color 255 13 18 25))
    Fill-RoundedRect -Graphics $g -Brush $notch -X 630 -Y 362 -W 94 -H 18 -R 9
    $notch.Dispose()

    $blue = New-Color 255 31 111 235
    $green = New-Color 255 45 212 149
    Draw-GlowLine -Graphics $g -A ([System.Drawing.PointF]::new(500, 438)) -B ([System.Drawing.PointF]::new(610, 478)) -Color $blue
    Draw-GlowLine -Graphics $g -A ([System.Drawing.PointF]::new(610, 546)) -B ([System.Drawing.PointF]::new(506, 566)) -Color $green

    $arcPen = [System.Drawing.Pen]::new((New-Color 230 255 255 255), 18)
    $arcPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $arcPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $g.DrawArc($arcPen, 190, 148, 660, 660, 215, 92)
    $arcPen.Dispose()

    $arcAccent = [System.Drawing.Pen]::new((New-Color 255 45 212 149), 18)
    $arcAccent.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $arcAccent.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $g.DrawArc($arcAccent, 232, 190, 576, 576, 20, 48)
    $arcAccent.Dispose()

    Save-Icon -Bitmap $canvas.Bitmap -Path $Path
  } finally {
    $g.Dispose()
    $canvas.Bitmap.Dispose()
  }
}

function Draw-RelayIcon {
  param([string]$Path)
  $canvas = New-IconCanvas -Size 1024
  $g = $canvas.Graphics
  try {
    $bgRect = New-Rect 0 0 1024 1024
    $bg = [System.Drawing.Drawing2D.LinearGradientBrush]::new(
      $bgRect,
      (New-Color 255 7 16 20),
      (New-Color 255 13 96 82),
      38.0
    )
    $g.FillRectangle($bg, $bgRect)
    $bg.Dispose()

    $pulse = [System.Drawing.Drawing2D.LinearGradientBrush]::new(
      (New-Rect 118 118 788 788),
      (New-Color 86 45 212 149),
      (New-Color 28 31 111 235),
      0.0
    )
    $g.FillEllipse($pulse, 118, 118, 788, 788)
    $pulse.Dispose()

    $ringPen = [System.Drawing.Pen]::new((New-Color 72 255 255 255), 24)
    $g.DrawEllipse($ringPen, 164, 164, 696, 696)
    $ringPen.Dispose()

    $ringPen2 = [System.Drawing.Pen]::new((New-Color 48 45 212 149), 16)
    $g.DrawEllipse($ringPen2, 238, 238, 548, 548)
    $ringPen2.Dispose()

    $left = [System.Drawing.PointF]::new(260, 610)
    $middle = [System.Drawing.PointF]::new(512, 430)
    $right = [System.Drawing.PointF]::new(764, 610)
    Draw-GlowLine -Graphics $g -A $left -B $middle -Color (New-Color 255 45 212 149)
    Draw-GlowLine -Graphics $g -A $middle -B $right -Color (New-Color 255 31 111 235)

    $nodeShadow = [System.Drawing.SolidBrush]::new((New-Color 88 0 0 0))
    foreach ($node in @($left, $middle, $right)) {
      $g.FillEllipse($nodeShadow, $node.X - 78, $node.Y - 58, 156, 156)
    }
    $nodeShadow.Dispose()

    $nodeFill = [System.Drawing.SolidBrush]::new((New-Color 255 247 251 255))
    $nodeInner = [System.Drawing.SolidBrush]::new((New-Color 255 15 23 32))
    foreach ($node in @($left, $middle, $right)) {
      $g.FillEllipse($nodeFill, $node.X - 72, $node.Y - 72, 144, 144)
      $g.FillEllipse($nodeInner, $node.X - 34, $node.Y - 34, 68, 68)
    }
    $nodeFill.Dispose()
    $nodeInner.Dispose()

    $tunnel = [System.Drawing.Pen]::new((New-Color 255 255 255 255), 20)
    $tunnel.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $tunnel.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $g.DrawArc($tunnel, 318, 252, 388, 388, 210, 120)
    $tunnel.Dispose()

    $bolt = [System.Drawing.Pen]::new((New-Color 255 45 212 149), 24)
    $bolt.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $bolt.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $g.DrawLine($bolt, 512, 316, 512, 386)
    $g.DrawLine($bolt, 512, 486, 512, 556)
    $bolt.Dispose()

    $small = [System.Drawing.SolidBrush]::new((New-Color 255 31 111 235))
    $g.FillEllipse($small, 488, 406, 48, 48)
    $small.Dispose()

    Save-Icon -Bitmap $canvas.Bitmap -Path $Path
  } finally {
    $g.Dispose()
    $canvas.Bitmap.Dispose()
  }
}

$outputDir = Join-Path $RepoRoot 'assets\icons'
New-Item -ItemType Directory -Force -Path $outputDir | Out-Null
$remoteMaster = Join-Path $outputDir 'codex-remote-app-icon-1024.png'
$relayMaster = Join-Path $outputDir 'hdc-relay-helper-icon-1024.png'
$remoteStart = Join-Path $outputDir 'codex-remote-start-icon-512.png'
$relayStart = Join-Path $outputDir 'hdc-relay-helper-start-icon-512.png'

Draw-RemoteIcon -Path $remoteMaster
Draw-RelayIcon -Path $relayMaster
Resize-Icon -Source $remoteMaster -Target $remoteStart -Size 512
Resize-Icon -Source $relayMaster -Target $relayStart -Size 512

Copy-Item -LiteralPath $remoteMaster -Destination (Join-Path $RepoRoot 'HarmonyCodexRemote\entry\src\main\resources\base\media\app_icon.png') -Force
Copy-Item -LiteralPath $remoteMaster -Destination (Join-Path $RepoRoot 'HarmonyCodexRemote\AppScope\resources\base\media\app_icon.png') -Force
Copy-Item -LiteralPath $remoteStart -Destination (Join-Path $RepoRoot 'HarmonyCodexRemote\entry\src\main\resources\base\media\start_icon.png') -Force
Copy-Item -LiteralPath $relayMaster -Destination (Join-Path $RepoRoot 'HarmonyHdcRelayHelper\entry\src\main\resources\base\media\app_icon.png') -Force
Copy-Item -LiteralPath $relayStart -Destination (Join-Path $RepoRoot 'HarmonyHdcRelayHelper\entry\src\main\resources\base\media\start_icon.png') -Force

Write-Host "Generated icons:"
Write-Host "  $remoteMaster"
Write-Host "  $remoteStart"
Write-Host "  $relayMaster"
Write-Host "  $relayStart"
